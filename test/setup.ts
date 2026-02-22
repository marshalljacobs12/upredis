import Redis from "ioredis";
import { afterAll, beforeEach } from "vitest";

let redis: Redis | undefined;

/**
 * Get a Redis client for testing.
 *
 * Uses REDIS_URL env var if set, otherwise connects to localhost:6380
 * (the port from our docker-compose.yml).
 *
 * Selects DB 1 to isolate test data from anything on DB 0.
 */
export async function getRedis(): Promise<Redis> {
	if (redis) return redis;

	const url = process.env.REDIS_URL ?? "redis://localhost:6380";
	redis = new Redis(url, { db: 1 });

	// Verify connection
	await redis.ping();
	return redis;
}

/**
 * Call this in your describe() block to get automatic
 * FLUSHDB before each test and cleanup after all tests.
 */
export function useRedis() {
	let client: Redis;

	beforeEach(async () => {
		client = await getRedis();
		await client.flushdb();
	});

	afterAll(async () => {
		if (redis) {
			await redis.quit();
			redis = undefined;
		}
	});

	return {
		get redis() {
			return client;
		},
	};
}
