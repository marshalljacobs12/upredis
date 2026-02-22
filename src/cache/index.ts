import type { Redis } from "ioredis";
import { prefixKey } from "../utils/key.js";

// --- Configuration ---

export interface CacheConfig {
	/** An ioredis client instance. You manage the connection lifecycle. */
	redis: Redis;
	/** Key prefix to avoid collisions. Default: "cache" */
	prefix?: string;
	/** Default TTL in seconds. If undefined, keys don't expire. */
	defaultTTL?: number;
	/** Custom serializer. Default: JSON.stringify */
	serialize?: (value: unknown) => string;
	/** Custom deserializer. Default: JSON.parse */
	deserialize?: (raw: string) => unknown;
}

interface GetOrSetSafeOptions {
	/** TTL in seconds for the cached value. Falls back to defaultTTL. */
	ttl?: number;
	/** How long the recompute lock is held (seconds). Default: 10 */
	lockTTL?: number;
	/** How long waiters poll for the value (ms). Default: 5000 */
	waitTimeout?: number;
	/** How often waiters poll (ms). Default: 50 */
	retryInterval?: number;
}

// --- Main class ---

/**
 * A Redis-backed cache with TTL, cache-aside pattern, optional
 * stampede protection, and batch operations.
 *
 * @example
 * ```ts
 * const cache = new Cache<User>({ redis, defaultTTL: 300 });
 *
 * // Simple get/set
 * await cache.set("user:42", { name: "alice" });
 * const user = await cache.get("user:42");
 *
 * // Cache-aside: loads from DB on miss, caches the result
 * const user = await cache.getOrSet("user:42", () => db.users.findById(42));
 *
 * // Cache-aside with stampede protection
 * const user = await cache.getOrSetSafe("user:42", () => db.users.findById(42));
 * ```
 */
export class Cache<T = unknown> {
	private redis: Redis;
	private prefix: string;
	private defaultTTL: number | undefined;
	private serialize: (value: unknown) => string;
	private deserialize: (raw: string) => unknown;

	constructor(config: CacheConfig) {
		this.redis = config.redis;
		this.prefix = config.prefix ?? "cache";
		this.defaultTTL = config.defaultTTL;
		this.serialize = config.serialize ?? JSON.stringify;
		this.deserialize = config.deserialize ?? JSON.parse;
	}

	/** Get a cached value. Returns null on cache miss. */
	async get(key: string): Promise<T | null> {
		const raw = await this.redis.get(this.key(key));
		if (raw === null) return null;
		return this.deserialize(raw) as T;
	}

	/** Set a cached value. TTL in seconds (falls back to defaultTTL). */
	async set(key: string, value: T, ttl?: number): Promise<void> {
		const effectiveTTL = ttl ?? this.defaultTTL;
		const serialized = this.serialize(value);

		if (effectiveTTL !== undefined) {
			await this.redis.set(this.key(key), serialized, "EX", effectiveTTL);
		} else {
			await this.redis.set(this.key(key), serialized);
		}
	}

	/** Delete a cached value. Returns true if the key existed. */
	async delete(key: string): Promise<boolean> {
		const removed = await this.redis.del(this.key(key));
		return removed === 1;
	}

	/** Check if a key exists in the cache. */
	async has(key: string): Promise<boolean> {
		const exists = await this.redis.exists(this.key(key));
		return exists === 1;
	}

	/**
	 * Cache-aside: return the cached value, or call `loader` on miss,
	 * cache the result, and return it.
	 *
	 * No stampede protection — if 100 callers miss simultaneously,
	 * all 100 will call the loader. Use `getOrSetSafe` if that matters.
	 */
	async getOrSet(
		key: string,
		loader: () => Promise<T>,
		ttl?: number,
	): Promise<T> {
		const cached = await this.get(key);
		if (cached !== null) return cached;

		const value = await loader();
		await this.set(key, value, ttl);
		return value;
	}

	/**
	 * Cache-aside with stampede protection. Only one caller runs the
	 * loader; all others wait for the result to appear in the cache.
	 *
	 * Uses a Redis lock (SET NX EX) to ensure a single loader runs.
	 * Waiters poll GET until the value appears or the timeout expires.
	 */
	async getOrSetSafe(
		key: string,
		loader: () => Promise<T>,
		options?: GetOrSetSafeOptions,
	): Promise<T> {
		// Check cache first — fast path
		const cached = await this.get(key);
		if (cached !== null) return cached;

		const ttl = options?.ttl;
		const lockTTL = options?.lockTTL ?? 10;
		const waitTimeout = options?.waitTimeout ?? 5000;
		const retryInterval = options?.retryInterval ?? 50;

		const lockKey = `${this.key(key)}:lock`;

		// Try to acquire the lock.
		// SET key value NX EX ttl — only sets if the key doesn't exist.
		const acquired = await this.redis.set(lockKey, "1", "EX", lockTTL, "NX");

		if (acquired === "OK") {
			// We got the lock — we're the one responsible for loading.
			try {
				const value = await loader();
				await this.set(key, value, ttl);
				return value;
			} finally {
				// Release the lock so others don't wait unnecessarily.
				await this.redis.del(lockKey);
			}
		}

		// Lock not acquired — another caller is loading. Poll until
		// the value appears in the cache or we time out.
		const deadline = Date.now() + waitTimeout;
		while (Date.now() < deadline) {
			await sleep(retryInterval);
			const value = await this.get(key);
			if (value !== null) return value;
		}

		// Timed out waiting. The lock holder probably crashed (the lock
		// will auto-expire via its TTL). Fall back to loading ourselves.
		const value = await loader();
		await this.set(key, value, ttl);
		return value;
	}

	/** Get multiple values in a single round trip. */
	async getMany(keys: string[]): Promise<Map<string, T | null>> {
		if (keys.length === 0) return new Map();

		const prefixedKeys = keys.map((k) => this.key(k));
		const pipeline = this.redis.pipeline();
		for (const pk of prefixedKeys) {
			pipeline.get(pk);
		}
		const results = await pipeline.exec();

		const map = new Map<string, T | null>();
		for (let i = 0; i < keys.length; i++) {
			const raw = results?.[i][1] as string | null;
			map.set(keys[i], raw !== null ? (this.deserialize(raw) as T) : null);
		}
		return map;
	}

	/** Set multiple values in a single round trip. */
	async setMany(
		entries: { key: string; value: T; ttl?: number }[],
	): Promise<void> {
		if (entries.length === 0) return;

		const pipeline = this.redis.pipeline();
		for (const entry of entries) {
			const effectiveTTL = entry.ttl ?? this.defaultTTL;
			const serialized = this.serialize(entry.value);
			const pk = this.key(entry.key);

			if (effectiveTTL !== undefined) {
				pipeline.set(pk, serialized, "EX", effectiveTTL);
			} else {
				pipeline.set(pk, serialized);
			}
		}
		await pipeline.exec();
	}

	/** Delete multiple keys in a single round trip. Returns number deleted. */
	async deleteMany(keys: string[]): Promise<number> {
		if (keys.length === 0) return 0;

		const prefixedKeys = keys.map((k) => this.key(k));
		return this.redis.del(...prefixedKeys);
	}

	/** Prefix a user-facing key with the configured namespace. */
	private key(key: string): string {
		return prefixKey(this.prefix, key);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
