import type { Redis } from "ioredis";
import { prefixKey } from "../utils/key.js";
import { createFixedWindow } from "./strategies/fixed-window.js";
import { createSlidingWindow } from "./strategies/sliding-window.js";
import { createTokenBucket } from "./strategies/token-bucket.js";
import type { RateLimitStrategy } from "./strategies/types.js";

// --- Configuration types (discriminated union by strategy) ---

interface RateLimiterBase {
	/** An ioredis client instance. You manage the connection lifecycle. */
	redis: Redis;
	/** Key prefix for all rate limiter keys. Default: "rl" */
	prefix?: string;
}

interface FixedWindowConfig extends RateLimiterBase {
	strategy: "fixed-window";
	/** Maximum number of requests allowed per window. */
	limit: number;
	/** Window duration in seconds. */
	window: number;
}

interface SlidingWindowConfig extends RateLimiterBase {
	strategy: "sliding-window";
	/** Maximum number of requests allowed per window. */
	limit: number;
	/** Window duration in seconds. */
	window: number;
}

interface TokenBucketConfig extends RateLimiterBase {
	strategy: "token-bucket";
	/** Maximum number of tokens the bucket can hold. */
	capacity: number;
	/** Number of tokens added per second. */
	refillRate: number;
}

export type RateLimiterConfig =
	| FixedWindowConfig
	| SlidingWindowConfig
	| TokenBucketConfig;

// --- Result type ---

export interface RateLimitResult {
	/** Whether the request is allowed. */
	allowed: boolean;
	/** How many requests remain in the current window / tokens remaining. */
	remaining: number;
	/** The configured limit / capacity. */
	limit: number;
	/** Seconds until the next request would be allowed. 0 if currently allowed. */
	retryAfter: number;
}

// --- Main class ---

/**
 * A Redis-backed rate limiter supporting fixed-window, sliding-window,
 * and token-bucket strategies.
 *
 * @example
 * ```ts
 * const limiter = new RateLimiter({
 *   redis,
 *   strategy: "sliding-window",
 *   limit: 100,
 *   window: 60,
 * });
 *
 * const result = await limiter.limit("user:42");
 * if (!result.allowed) {
 *   // reject — retry after result.retryAfter seconds
 * }
 * ```
 */
export class RateLimiter {
	private strategy: RateLimitStrategy;
	private prefix: string;

	constructor(config: RateLimiterConfig) {
		this.prefix = config.prefix ?? "rl";

		switch (config.strategy) {
			case "fixed-window":
				this.strategy = createFixedWindow(
					config.redis,
					config.limit,
					config.window,
				);
				break;
			case "sliding-window":
				this.strategy = createSlidingWindow(
					config.redis,
					config.limit,
					config.window,
				);
				break;
			case "token-bucket":
				this.strategy = createTokenBucket(
					config.redis,
					config.capacity,
					config.refillRate,
				);
				break;
		}
	}

	/**
	 * Check if a request is allowed and consume one unit.
	 * This is the primary method — call it on every incoming request.
	 */
	async limit(key: string): Promise<RateLimitResult> {
		return this.strategy.limit(prefixKey(this.prefix, key));
	}

	/**
	 * Check the current state without consuming a unit.
	 * Useful for displaying remaining quota to users.
	 */
	async peek(key: string): Promise<RateLimitResult> {
		return this.strategy.peek(prefixKey(this.prefix, key));
	}

	/**
	 * Reset all rate limit state for a key.
	 */
	async reset(key: string): Promise<void> {
		return this.strategy.reset(prefixKey(this.prefix, key));
	}
}
