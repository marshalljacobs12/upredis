import type { Redis } from "ioredis";
import type { RateLimitResult } from "../index.js";
import type { RateLimitStrategy } from "./types.js";

/**
 * Derive the Redis key for the current window.
 *
 * We floor the current timestamp to the nearest window boundary and
 * append it to the base key. Each window gets its own independent
 * counter that auto-expires when the window ends.
 *
 * Example with window=60:
 *   timestamp 1708617624 → floor(1708617624/60)*60 = 1708617600
 *   key = "rl:user:42:1708617600"
 */
function windowKey(baseKey: string, windowSec: number): string {
	const now = Math.floor(Date.now() / 1000);
	const windowStart = Math.floor(now / windowSec) * windowSec;
	return `${baseKey}:${windowStart}`;
}

/**
 * How many seconds remain until the current window expires.
 */
function secondsUntilWindowEnd(windowSec: number): number {
	const now = Date.now() / 1000;
	const windowStart = Math.floor(now / windowSec) * windowSec;
	return Math.ceil(windowStart + windowSec - now);
}

export function createFixedWindow(
	redis: Redis,
	limit: number,
	windowSec: number,
): RateLimitStrategy {
	return {
		async limit(key: string): Promise<RateLimitResult> {
			const wKey = windowKey(key, windowSec);

			// INCR is atomic — if the key doesn't exist, Redis creates it at 0
			// then increments to 1, all in one step.
			const count = await redis.incr(wKey);

			// On the very first request in this window (count === 1), set the
			// expiry so the key self-destructs when the window ends.
			// If we crash between INCR and EXPIRE, the key lives forever —
			// but it's just a stale counter, not a correctness issue.
			if (count === 1) {
				await redis.expire(wKey, windowSec);
			}

			const allowed = count <= limit;
			return {
				allowed,
				remaining: Math.max(0, limit - count),
				limit,
				retryAfter: allowed ? 0 : secondsUntilWindowEnd(windowSec),
			};
		},

		async peek(key: string): Promise<RateLimitResult> {
			const wKey = windowKey(key, windowSec);

			// GET instead of INCR — read without consuming.
			// Returns null if the key doesn't exist (no requests yet).
			const raw = await redis.get(wKey);
			const count = raw ? Number.parseInt(raw, 10) : 0;

			const allowed = count < limit;
			return {
				allowed,
				remaining: Math.max(0, limit - count),
				limit,
				retryAfter: allowed ? 0 : secondsUntilWindowEnd(windowSec),
			};
		},

		async reset(key: string): Promise<void> {
			// DEL the current window's key. This resets the counter to 0
			// for this window. Previous windows are already expired or
			// will expire on their own.
			const wKey = windowKey(key, windowSec);
			await redis.del(wKey);
		},
	};
}
