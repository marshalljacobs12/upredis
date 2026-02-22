import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Redis } from "ioredis";
import type { RateLimitResult } from "../index.js";
import type { RateLimitStrategy } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(
	join(__dirname, "..", "scripts", "token-bucket.lua"),
	"utf-8",
);

export function createTokenBucket(
	redis: Redis,
	capacity: number,
	refillRate: number,
): RateLimitStrategy {
	/**
	 * Call the Lua script with a consume flag.
	 * consume=true for limit(), consume=false for peek().
	 */
	async function run(key: string, consume: boolean): Promise<RateLimitResult> {
		const nowMs = Date.now();

		const [allowed, remaining] = (await redis.eval(
			SCRIPT,
			1,
			key,
			capacity.toString(),
			refillRate.toString(),
			nowMs.toString(),
			consume ? "1" : "0",
		)) as [number, number];

		// retryAfter: if rejected, the time until one token refills
		const retryAfter = allowed === 1 ? 0 : Math.ceil(1 / refillRate);

		return {
			allowed: allowed === 1,
			remaining,
			limit: capacity,
			retryAfter,
		};
	}

	return {
		limit(key: string) {
			return run(key, true);
		},
		peek(key: string) {
			return run(key, false);
		},
		async reset(key: string) {
			await redis.del(key);
		},
	};
}
