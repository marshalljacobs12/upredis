import type Redis from "ioredis";

/**
 * Re-export the Redis client type from ioredis.
 * All abstractions accept this as a constructor parameter —
 * you create and manage the connection, we just use it.
 */
export type { Redis };
