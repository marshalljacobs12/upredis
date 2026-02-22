import type { Redis } from "ioredis";
import type { RateLimitStrategy } from "./types.js";

export function createTokenBucket(
	_redis: Redis,
	_capacity: number,
	_refillRate: number,
): RateLimitStrategy {
	throw new Error("Token bucket strategy not yet implemented");
}
