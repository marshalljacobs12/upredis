import type { Redis } from "ioredis";
import type { RateLimitStrategy } from "./types.js";

export function createSlidingWindow(
	_redis: Redis,
	_limit: number,
	_windowSec: number,
): RateLimitStrategy {
	throw new Error("Sliding window strategy not yet implemented");
}
