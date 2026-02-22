import { describe, it, expect } from "vitest";
import { RateLimiter } from "../src/rate-limiter/index.js";
import { useRedis } from "./setup.js";

describe("RateLimiter", () => {
	const ctx = useRedis();

	describe("fixed-window", () => {
		function createLimiter(limit: number, window: number) {
			return new RateLimiter({
				redis: ctx.redis,
				strategy: "fixed-window",
				limit,
				window,
			});
		}

		it("allows requests under the limit", async () => {
			const limiter = createLimiter(3, 60);

			const r1 = await limiter.limit("user:1");
			expect(r1.allowed).toBe(true);
			expect(r1.remaining).toBe(2);
			expect(r1.limit).toBe(3);
			expect(r1.retryAfter).toBe(0);

			const r2 = await limiter.limit("user:1");
			expect(r2.allowed).toBe(true);
			expect(r2.remaining).toBe(1);

			const r3 = await limiter.limit("user:1");
			expect(r3.allowed).toBe(true);
			expect(r3.remaining).toBe(0);
		});

		it("rejects requests over the limit", async () => {
			const limiter = createLimiter(2, 60);

			await limiter.limit("user:1");
			await limiter.limit("user:1");

			const r3 = await limiter.limit("user:1");
			expect(r3.allowed).toBe(false);
			expect(r3.remaining).toBe(0);
			expect(r3.retryAfter).toBeGreaterThan(0);
			expect(r3.retryAfter).toBeLessThanOrEqual(60);
		});

		it("isolates different keys", async () => {
			const limiter = createLimiter(1, 60);

			const r1 = await limiter.limit("user:a");
			expect(r1.allowed).toBe(true);

			// Different key — should still be allowed
			const r2 = await limiter.limit("user:b");
			expect(r2.allowed).toBe(true);

			// Original key is now exhausted
			const r3 = await limiter.limit("user:a");
			expect(r3.allowed).toBe(false);
		});

		it("peek reads without consuming", async () => {
			const limiter = createLimiter(2, 60);

			// Peek before any requests
			const p1 = await limiter.peek("user:1");
			expect(p1.allowed).toBe(true);
			expect(p1.remaining).toBe(2);

			// Consume one
			await limiter.limit("user:1");

			// Peek should show 1 remaining, not consume another
			const p2 = await limiter.peek("user:1");
			expect(p2.allowed).toBe(true);
			expect(p2.remaining).toBe(1);

			// Peek again — still 1, because peek doesn't consume
			const p3 = await limiter.peek("user:1");
			expect(p3.remaining).toBe(1);
		});

		it("reset clears the counter", async () => {
			const limiter = createLimiter(1, 60);

			await limiter.limit("user:1");
			const r1 = await limiter.limit("user:1");
			expect(r1.allowed).toBe(false);

			await limiter.reset("user:1");

			const r2 = await limiter.limit("user:1");
			expect(r2.allowed).toBe(true);
			expect(r2.remaining).toBe(0);
		});

		it("window expires and counter resets naturally", async () => {
			// Use a 1-second window so we can wait for it to expire
			const limiter = createLimiter(1, 1);

			const r1 = await limiter.limit("user:1");
			expect(r1.allowed).toBe(true);

			const r2 = await limiter.limit("user:1");
			expect(r2.allowed).toBe(false);

			// Wait for the window to expire
			await new Promise((resolve) => setTimeout(resolve, 1100));

			const r3 = await limiter.limit("user:1");
			expect(r3.allowed).toBe(true);
		});
	});
});
