import { describe, expect, it, vi } from "vitest";
import { Cache } from "../src/cache/index.js";
import { useRedis } from "./setup.js";

describe("Cache", () => {
	const ctx = useRedis();

	function createCache(defaultTTL?: number) {
		return new Cache<{ name: string }>({
			redis: ctx.redis,
			defaultTTL,
		});
	}

	describe("get / set", () => {
		it("returns null on cache miss", async () => {
			const cache = createCache();
			expect(await cache.get("missing")).toBeNull();
		});

		it("stores and retrieves a value", async () => {
			const cache = createCache();
			await cache.set("user:1", { name: "alice" });

			const result = await cache.get("user:1");
			expect(result).toEqual({ name: "alice" });
		});

		it("respects per-key TTL", async () => {
			const cache = createCache();
			await cache.set("user:1", { name: "alice" }, 1);

			expect(await cache.get("user:1")).toEqual({ name: "alice" });

			await new Promise((resolve) => setTimeout(resolve, 1100));

			expect(await cache.get("user:1")).toBeNull();
		});

		it("respects default TTL", async () => {
			const cache = createCache(1);
			await cache.set("user:1", { name: "alice" });

			expect(await cache.get("user:1")).toEqual({ name: "alice" });

			await new Promise((resolve) => setTimeout(resolve, 1100));

			expect(await cache.get("user:1")).toBeNull();
		});

		it("per-key TTL overrides default TTL", async () => {
			const cache = createCache(60);
			// Set a 1-second TTL that overrides the 60-second default
			await cache.set("user:1", { name: "alice" }, 1);

			await new Promise((resolve) => setTimeout(resolve, 1100));

			expect(await cache.get("user:1")).toBeNull();
		});

		it("stores without expiry when no TTL configured", async () => {
			const cache = createCache();
			await cache.set("user:1", { name: "alice" });

			// Check that no TTL is set (-1 means no expiry)
			const ttl = await ctx.redis.ttl("cache:user:1");
			expect(ttl).toBe(-1);
		});
	});

	describe("delete", () => {
		it("deletes an existing key and returns true", async () => {
			const cache = createCache();
			await cache.set("user:1", { name: "alice" });

			expect(await cache.delete("user:1")).toBe(true);
			expect(await cache.get("user:1")).toBeNull();
		});

		it("returns false for non-existent key", async () => {
			const cache = createCache();
			expect(await cache.delete("missing")).toBe(false);
		});
	});

	describe("has", () => {
		it("returns true for existing key", async () => {
			const cache = createCache();
			await cache.set("user:1", { name: "alice" });
			expect(await cache.has("user:1")).toBe(true);
		});

		it("returns false for non-existent key", async () => {
			const cache = createCache();
			expect(await cache.has("missing")).toBe(false);
		});
	});

	describe("getOrSet", () => {
		it("returns cached value without calling loader", async () => {
			const cache = createCache();
			await cache.set("user:1", { name: "alice" });

			const loader = vi.fn().mockResolvedValue({ name: "bob" });
			const result = await cache.getOrSet("user:1", loader);

			expect(result).toEqual({ name: "alice" });
			expect(loader).not.toHaveBeenCalled();
		});

		it("calls loader on miss and caches the result", async () => {
			const cache = createCache();

			const loader = vi.fn().mockResolvedValue({ name: "alice" });
			const result = await cache.getOrSet("user:1", loader);

			expect(result).toEqual({ name: "alice" });
			expect(loader).toHaveBeenCalledOnce();

			// Verify it's now cached
			expect(await cache.get("user:1")).toEqual({ name: "alice" });
		});

		it("respects TTL parameter", async () => {
			const cache = createCache();

			await cache.getOrSet("user:1", async () => ({ name: "alice" }), 1);

			await new Promise((resolve) => setTimeout(resolve, 1100));

			expect(await cache.get("user:1")).toBeNull();
		});
	});

	describe("getOrSetSafe", () => {
		it("returns cached value without calling loader", async () => {
			const cache = createCache();
			await cache.set("user:1", { name: "alice" });

			const loader = vi.fn().mockResolvedValue({ name: "bob" });
			const result = await cache.getOrSetSafe("user:1", loader);

			expect(result).toEqual({ name: "alice" });
			expect(loader).not.toHaveBeenCalled();
		});

		it("calls loader on miss and caches the result", async () => {
			const cache = createCache();

			const loader = vi.fn().mockResolvedValue({ name: "alice" });
			const result = await cache.getOrSetSafe("user:1", loader);

			expect(result).toEqual({ name: "alice" });
			expect(loader).toHaveBeenCalledOnce();
			expect(await cache.get("user:1")).toEqual({ name: "alice" });
		});

		it("only one caller runs the loader under contention", async () => {
			const cache = createCache();
			let loaderCallCount = 0;

			// Simulate a slow loader (100ms)
			const loader = async () => {
				loaderCallCount++;
				await new Promise((resolve) => setTimeout(resolve, 100));
				return { name: "alice" };
			};

			// Fire 5 concurrent getOrSetSafe calls
			const results = await Promise.all([
				cache.getOrSetSafe("user:1", loader, { retryInterval: 20 }),
				cache.getOrSetSafe("user:1", loader, { retryInterval: 20 }),
				cache.getOrSetSafe("user:1", loader, { retryInterval: 20 }),
				cache.getOrSetSafe("user:1", loader, { retryInterval: 20 }),
				cache.getOrSetSafe("user:1", loader, { retryInterval: 20 }),
			]);

			// All should get the same result
			for (const result of results) {
				expect(result).toEqual({ name: "alice" });
			}

			// Only one should have called the loader
			expect(loaderCallCount).toBe(1);
		});

		it("falls back to loading if lock holder times out", async () => {
			const cache = createCache();

			// Manually acquire the lock to simulate a crashed holder
			await ctx.redis.set("cache:user:1:lock", "1", "EX", 1);

			const result = await cache.getOrSetSafe(
				"user:1",
				async () => ({ name: "alice" }),
				{ waitTimeout: 1500, retryInterval: 20 },
			);

			expect(result).toEqual({ name: "alice" });
		});
	});

	describe("getMany", () => {
		it("returns values for multiple keys", async () => {
			const cache = createCache();
			await cache.set("user:1", { name: "alice" });
			await cache.set("user:2", { name: "bob" });

			const results = await cache.getMany(["user:1", "user:2", "user:3"]);

			expect(results.get("user:1")).toEqual({ name: "alice" });
			expect(results.get("user:2")).toEqual({ name: "bob" });
			expect(results.get("user:3")).toBeNull();
		});

		it("returns empty map for empty input", async () => {
			const cache = createCache();
			const results = await cache.getMany([]);
			expect(results.size).toBe(0);
		});
	});

	describe("setMany", () => {
		it("sets multiple values at once", async () => {
			const cache = createCache();
			await cache.setMany([
				{ key: "user:1", value: { name: "alice" } },
				{ key: "user:2", value: { name: "bob" } },
			]);

			expect(await cache.get("user:1")).toEqual({ name: "alice" });
			expect(await cache.get("user:2")).toEqual({ name: "bob" });
		});

		it("respects per-entry TTL", async () => {
			const cache = createCache();
			await cache.setMany([
				{ key: "user:1", value: { name: "alice" }, ttl: 1 },
			]);

			await new Promise((resolve) => setTimeout(resolve, 1100));

			expect(await cache.get("user:1")).toBeNull();
		});
	});

	describe("deleteMany", () => {
		it("deletes multiple keys and returns count", async () => {
			const cache = createCache();
			await cache.set("user:1", { name: "alice" });
			await cache.set("user:2", { name: "bob" });

			const deleted = await cache.deleteMany(["user:1", "user:2", "user:3"]);
			expect(deleted).toBe(2);

			expect(await cache.get("user:1")).toBeNull();
			expect(await cache.get("user:2")).toBeNull();
		});

		it("returns 0 for empty input", async () => {
			const cache = createCache();
			expect(await cache.deleteMany([])).toBe(0);
		});
	});
});
