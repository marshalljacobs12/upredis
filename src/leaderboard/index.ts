import type { Redis } from "ioredis";
import { prefixKey } from "../utils/key.js";

// --- Configuration ---

export interface LeaderboardConfig {
	/** An ioredis client instance. You manage the connection lifecycle. */
	redis: Redis;
	/** Logical name for this leaderboard (e.g. "weekly-scores"). */
	key: string;
	/** Key prefix to avoid collisions. Default: "lb" */
	prefix?: string;
	/**
	 * Sort order for rankings.
	 * - "highToLow" (default): highest score = rank 0. Use for points, kills, revenue.
	 * - "lowToHigh": lowest score = rank 0. Use for race times, golf scores.
	 */
	sortOrder?: "highToLow" | "lowToHigh";
}

// --- Result types ---

export interface LeaderboardEntry {
	member: string;
	score: number;
	/** 0-indexed rank. */
	rank: number;
}

// --- Main class ---

/**
 * A Redis sorted-set-backed leaderboard with rank lookup, top-N,
 * and neighborhood queries.
 *
 * @example
 * ```ts
 * const lb = new Leaderboard({ redis, key: "weekly-scores" });
 *
 * await lb.upsert("alice", 2850);
 * await lb.upsert("bob", 2340);
 * await lb.increment("alice", 50); // now 2900
 *
 * const top3 = await lb.top(3);
 * const aliceRank = await lb.rank("alice"); // { member: "alice", score: 2900, rank: 0 }
 * ```
 */
export class Leaderboard {
	private redis: Redis;
	private redisKey: string;
	private desc: boolean;

	constructor(config: LeaderboardConfig) {
		this.redis = config.redis;
		this.redisKey = prefixKey(config.prefix ?? "lb", config.key);
		this.desc = (config.sortOrder ?? "highToLow") === "highToLow";
	}

	/** Add a member with a score, or replace their score if they already exist. */
	async upsert(member: string, score: number): Promise<void> {
		await this.redis.zadd(this.redisKey, score.toString(), member);
	}

	/** Increment a member's score by `amount`. Returns the new score. */
	async increment(member: string, amount: number): Promise<number> {
		const newScore = await this.redis.zincrby(this.redisKey, amount, member);
		return Number.parseFloat(newScore);
	}

	/**
	 * Get a member's rank and score.
	 * Returns null if the member doesn't exist in the leaderboard.
	 */
	async rank(member: string): Promise<LeaderboardEntry | null> {
		// Use a pipeline to fetch rank and score in one round trip.
		const pipeline = this.redis.pipeline();
		if (this.desc) {
			pipeline.zrevrank(this.redisKey, member);
		} else {
			pipeline.zrank(this.redisKey, member);
		}
		pipeline.zscore(this.redisKey, member);
		const results = await pipeline.exec();

		const rank = results?.[0][1] as number | null;
		const score = results?.[1][1] as string | null;

		if (rank === null || score === null) return null;

		return { member, score: Number.parseFloat(score), rank };
	}

	/** Get the top `count` members. */
	async top(count: number): Promise<LeaderboardEntry[]> {
		const raw = this.desc
			? await this.redis.zrevrange(this.redisKey, 0, count - 1, "WITHSCORES")
			: await this.redis.zrange(this.redisKey, 0, count - 1, "WITHSCORES");

		return this.parseWithScores(raw, 0);
	}

	/**
	 * Get members around a given member (their neighborhood).
	 * Returns up to `count` members above and `count` below, plus the member.
	 */
	async around(member: string, count: number): Promise<LeaderboardEntry[]> {
		// First, find the member's rank
		const memberRank = this.desc
			? await this.redis.zrevrank(this.redisKey, member)
			: await this.redis.zrank(this.redisKey, member);

		if (memberRank === null) return [];

		const start = Math.max(0, memberRank - count);
		const stop = memberRank + count;

		const raw = this.desc
			? await this.redis.zrevrange(this.redisKey, start, stop, "WITHSCORES")
			: await this.redis.zrange(this.redisKey, start, stop, "WITHSCORES");

		return this.parseWithScores(raw, start);
	}

	/** Remove a member. Returns true if the member existed. */
	async remove(member: string): Promise<boolean> {
		const removed = await this.redis.zrem(this.redisKey, member);
		return removed === 1;
	}

	/** Total number of members in the leaderboard. */
	async count(): Promise<number> {
		return this.redis.zcard(this.redisKey);
	}

	/** Get all members with scores between `min` and `max` (inclusive). */
	async range(min: number, max: number): Promise<LeaderboardEntry[]> {
		// ZRANGEBYSCORE always returns low→high regardless of sort order.
		// We fetch the members and scores, then look up actual ranks.
		const raw = await this.redis.zrangebyscore(
			this.redisKey,
			min,
			max,
			"WITHSCORES",
		);

		if (raw.length === 0) return [];

		// Parse the flat array into member/score pairs
		const members: { member: string; score: number }[] = [];
		for (let i = 0; i < raw.length; i += 2) {
			members.push({
				member: raw[i],
				score: Number.parseFloat(raw[i + 1]),
			});
		}

		// Fetch actual ranks for each member in one round trip
		const pipeline = this.redis.pipeline();
		for (const { member } of members) {
			if (this.desc) {
				pipeline.zrevrank(this.redisKey, member);
			} else {
				pipeline.zrank(this.redisKey, member);
			}
		}
		const rankResults = await pipeline.exec();

		return members.map((m, i) => ({
			...m,
			rank: rankResults?.[i][1] as number,
		}));
	}

	/**
	 * Parse the flat [member, score, member, score, ...] array returned
	 * by ZRANGE/ZREVRANGE WITHSCORES into LeaderboardEntry objects.
	 *
	 * `startRank` is the rank of the first element in the result
	 * (from the range query's start index).
	 */
	private parseWithScores(
		raw: string[],
		startRank: number,
	): LeaderboardEntry[] {
		const entries: LeaderboardEntry[] = [];
		for (let i = 0; i < raw.length; i += 2) {
			entries.push({
				member: raw[i],
				score: Number.parseFloat(raw[i + 1]),
				rank: startRank + i / 2,
			});
		}
		return entries;
	}
}
