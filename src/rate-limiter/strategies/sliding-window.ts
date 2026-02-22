import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Redis } from "ioredis";
import type { RateLimitResult } from "../index.js";
import type { RateLimitStrategy } from "./types.js";

// Load the Lua script once at module load time.
// In production, ioredis will cache it via EVALSHA after the first call.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(
	join(__dirname, "..", "scripts", "sliding-window.lua"),
	"utf-8",
);

/**
 * Generate a unique member ID for each request.
 * We use timestamp:random to avoid sorted set member collisions —
 * if two requests arrive at the exact same millisecond, the random
 * suffix ensures they're stored as separate entries.
 */
function requestId(nowMs: number): string {
	return `${nowMs}:${Math.random().toString(36).slice(2, 10)}`;
}

export function createSlidingWindow(
	redis: Redis,
	limit: number,
	windowSec: number,
): RateLimitStrategy {
	const windowMs = windowSec * 1000;

	return {
		async limit(key: string): Promise<RateLimitResult> {
			const nowMs = Date.now();
			const windowStart = nowMs - windowMs;

			// eval(script, numKeys, ...keys, ...args)
			// Returns [allowed (0/1), count]
			const [allowed, count] = (await redis.eval(
				SCRIPT,
				1,
				key,
				windowStart.toString(),
				nowMs.toString(),
				limit.toString(),
				requestId(nowMs),
				windowSec.toString(),
			)) as [number, number];

			return {
				allowed: allowed === 1,
				remaining: Math.max(0, limit - count),
				limit,
				retryAfter: allowed === 1 ? 0 : windowSec,
			};
		},

		async peek(key: string): Promise<RateLimitResult> {
			const nowMs = Date.now();
			const windowStart = nowMs - windowMs;

			// Clean up expired entries, then count — but don't add anything.
			// We use a pipeline (two commands) rather than Lua here
			// because there's no conditional logic needed for a read-only peek.
			const pipeline = redis.pipeline();
			pipeline.zremrangebyscore(key, "-inf", windowStart);
			pipeline.zcard(key);
			const results = await pipeline.exec();

			// pipeline.exec() returns [[err, result], [err, result], ...]
			const count = (results![1][1] as number) ?? 0;

			const allowed = count < limit;
			return {
				allowed,
				remaining: Math.max(0, limit - count),
				limit,
				retryAfter: allowed ? 0 : windowSec,
			};
		},

		async reset(key: string): Promise<void> {
			await redis.del(key);
		},
	};
}
