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

	describe("sliding-window", () => {
		function createLimiter(limit: number, window: number) {
			return new RateLimiter({
				redis: ctx.redis,
				strategy: "sliding-window",
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
			expect(r3.retryAfter).toBe(60);
		});

		it("isolates different keys", async () => {
			const limiter = createLimiter(1, 60);

			const r1 = await limiter.limit("user:a");
			expect(r1.allowed).toBe(true);

			const r2 = await limiter.limit("user:b");
			expect(r2.allowed).toBe(true);

			const r3 = await limiter.limit("user:a");
			expect(r3.allowed).toBe(false);
		});

		it("peek reads without consuming", async () => {
			const limiter = createLimiter(2, 60);

			const p1 = await limiter.peek("user:1");
			expect(p1.allowed).toBe(true);
			expect(p1.remaining).toBe(2);

			await limiter.limit("user:1");

			const p2 = await limiter.peek("user:1");
			expect(p2.allowed).toBe(true);
			expect(p2.remaining).toBe(1);

			const p3 = await limiter.peek("user:1");
			expect(p3.remaining).toBe(1);
		});

		it("reset clears all entries", async () => {
			const limiter = createLimiter(1, 60);

			await limiter.limit("user:1");
			const r1 = await limiter.limit("user:1");
			expect(r1.allowed).toBe(false);

			await limiter.reset("user:1");

			const r2 = await limiter.limit("user:1");
			expect(r2.allowed).toBe(true);
		});

		it("window slides — old entries expire naturally", async () => {
			const limiter = createLimiter(1, 1);

			const r1 = await limiter.limit("user:1");
			expect(r1.allowed).toBe(true);

			const r2 = await limiter.limit("user:1");
			expect(r2.allowed).toBe(false);

			// Wait for the entry to fall outside the sliding window
			await new Promise((resolve) => setTimeout(resolve, 1100));

			const r3 = await limiter.limit("user:1");
			expect(r3.allowed).toBe(true);
		});
	});

	describe("token-bucket", () => {
		function createLimiter(capacity: number, refillRate: number) {
			return new RateLimiter({
				redis: ctx.redis,
				strategy: "token-bucket",
				capacity,
				refillRate,
			});
		}

		it("allows requests while tokens are available", async () => {
			const limiter = createLimiter(3, 1);

			const r1 = await limiter.limit("user:1");
			expect(r1.allowed).toBe(true);
			expect(r1.remaining).toBe(2);
			expect(r1.limit).toBe(3);

			const r2 = await limiter.limit("user:1");
			expect(r2.allowed).toBe(true);
			expect(r2.remaining).toBe(1);

			const r3 = await limiter.limit("user:1");
			expect(r3.allowed).toBe(true);
			expect(r3.remaining).toBe(0);
		});

		it("rejects when bucket is empty", async () => {
			const limiter = createLimiter(1, 1);

			await limiter.limit("user:1");

			const r2 = await limiter.limit("user:1");
			expect(r2.allowed).toBe(false);
			expect(r2.remaining).toBe(0);
			expect(r2.retryAfter).toBeGreaterThan(0);
		});

		it("refills tokens over time", async () => {
			// capacity=2, refill=2/sec → 1 token every 500ms
			const limiter = createLimiter(2, 2);

			// Drain the bucket
			await limiter.limit("user:1");
			await limiter.limit("user:1");
			const empty = await limiter.limit("user:1");
			expect(empty.allowed).toBe(false);

			// Wait 600ms — should refill ~1.2 tokens (floor to 1)
			await new Promise((resolve) => setTimeout(resolve, 600));

			const r = await limiter.limit("user:1");
			expect(r.allowed).toBe(true);
		});

		it("tokens cap at capacity", async () => {
			const limiter = createLimiter(2, 100);

			// Wait to ensure bucket is full (refill is very fast)
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Peek should show 2 remaining, not more
			const p = await limiter.peek("user:1");
			expect(p.remaining).toBe(2);
		});

		it("peek reads without consuming", async () => {
			const limiter = createLimiter(2, 1);

			await limiter.limit("user:1");

			const p1 = await limiter.peek("user:1");
			expect(p1.remaining).toBe(1);

			// Peek again — still 1
			const p2 = await limiter.peek("user:1");
			expect(p2.remaining).toBe(1);
		});

		it("isolates different keys", async () => {
			const limiter = createLimiter(1, 1);

			const r1 = await limiter.limit("user:a");
			expect(r1.allowed).toBe(true);

			const r2 = await limiter.limit("user:b");
			expect(r2.allowed).toBe(true);

			const r3 = await limiter.limit("user:a");
			expect(r3.allowed).toBe(false);
		});

		it("reset restores a full bucket", async () => {
			const limiter = createLimiter(1, 1);

			await limiter.limit("user:1");
			const empty = await limiter.limit("user:1");
			expect(empty.allowed).toBe(false);

			await limiter.reset("user:1");

			const r = await limiter.limit("user:1");
			expect(r.allowed).toBe(true);
		});
	});
});
