import type { RateLimitResult } from "../index.js";

/**
 * Internal interface that each rate limiting strategy implements.
 * The RateLimiter class delegates to whichever strategy was configured.
 */
export interface RateLimitStrategy {
	limit(key: string): Promise<RateLimitResult>;
	peek(key: string): Promise<RateLimitResult>;
	reset(key: string): Promise<void>;
}
