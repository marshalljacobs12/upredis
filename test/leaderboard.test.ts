import { describe, it, expect } from "vitest";
import { Leaderboard } from "../src/leaderboard/index.js";
import { useRedis } from "./setup.js";

describe("Leaderboard", () => {
	const ctx = useRedis();

	function createBoard(
		key = "test-board",
		sortOrder?: "highToLow" | "lowToHigh",
	) {
		return new Leaderboard({ redis: ctx.redis, key, sortOrder });
	}

	/** Seed a leaderboard with some players for tests that need data. */
	async function seed(lb: Leaderboard) {
		await lb.upsert("alice", 2850);
		await lb.upsert("bob", 2340);
		await lb.upsert("charlie", 1900);
		await lb.upsert("dave", 750);
		await lb.upsert("eve", 3100);
	}

	describe("upsert", () => {
		it("adds new members", async () => {
			const lb = createBoard();
			await lb.upsert("alice", 100);
			expect(await lb.count()).toBe(1);
		});

		it("updates score for existing members", async () => {
			const lb = createBoard();
			await lb.upsert("alice", 100);
			await lb.upsert("alice", 200);

			expect(await lb.count()).toBe(1);
			const entry = await lb.rank("alice");
			expect(entry!.score).toBe(200);
		});
	});

	describe("increment", () => {
		it("increments and returns the new score", async () => {
			const lb = createBoard();
			await lb.upsert("alice", 100);

			const newScore = await lb.increment("alice", 50);
			expect(newScore).toBe(150);
		});

		it("creates the member if they don't exist", async () => {
			const lb = createBoard();
			const newScore = await lb.increment("alice", 50);
			expect(newScore).toBe(50);
			expect(await lb.count()).toBe(1);
		});

		it("supports negative increments", async () => {
			const lb = createBoard();
			await lb.upsert("alice", 100);
			const newScore = await lb.increment("alice", -30);
			expect(newScore).toBe(70);
		});
	});

	describe("rank", () => {
		it("returns rank and score for existing member", async () => {
			const lb = createBoard();
			await seed(lb);

			// eve has the highest score (3100), so rank 0 in highToLow
			const entry = await lb.rank("eve");
			expect(entry).toEqual({ member: "eve", score: 3100, rank: 0 });
		});

		it("returns null for non-existent member", async () => {
			const lb = createBoard();
			await seed(lb);

			const entry = await lb.rank("nobody");
			expect(entry).toBeNull();
		});

		it("respects lowToHigh sort order", async () => {
			const lb = createBoard("low-board", "lowToHigh");
			await seed(lb);

			// dave has the lowest score (750), so rank 0 in lowToHigh
			const entry = await lb.rank("dave");
			expect(entry).toEqual({ member: "dave", score: 750, rank: 0 });
		});
	});

	describe("top", () => {
		it("returns top N members in order", async () => {
			const lb = createBoard();
			await seed(lb);

			const top3 = await lb.top(3);
			expect(top3).toEqual([
				{ member: "eve", score: 3100, rank: 0 },
				{ member: "alice", score: 2850, rank: 1 },
				{ member: "bob", score: 2340, rank: 2 },
			]);
		});

		it("returns all members if count exceeds size", async () => {
			const lb = createBoard();
			await seed(lb);

			const all = await lb.top(100);
			expect(all).toHaveLength(5);
			expect(all[0].member).toBe("eve");
			expect(all[4].member).toBe("dave");
		});

		it("returns empty array for empty leaderboard", async () => {
			const lb = createBoard();
			expect(await lb.top(10)).toEqual([]);
		});
	});

	describe("around", () => {
		it("returns neighborhood around a member", async () => {
			const lb = createBoard();
			await seed(lb);

			// alice is rank 1. around(alice, 1) should give ranks 0-2.
			const neighborhood = await lb.around("alice", 1);
			expect(neighborhood).toEqual([
				{ member: "eve", score: 3100, rank: 0 },
				{ member: "alice", score: 2850, rank: 1 },
				{ member: "bob", score: 2340, rank: 2 },
			]);
		});

		it("clamps at the top of the leaderboard", async () => {
			const lb = createBoard();
			await seed(lb);

			// eve is rank 0. around(eve, 2) can't go above 0.
			const neighborhood = await lb.around("eve", 2);
			expect(neighborhood[0].member).toBe("eve");
			expect(neighborhood[0].rank).toBe(0);
		});

		it("returns empty for non-existent member", async () => {
			const lb = createBoard();
			await seed(lb);

			expect(await lb.around("nobody", 2)).toEqual([]);
		});
	});

	describe("remove", () => {
		it("removes an existing member and returns true", async () => {
			const lb = createBoard();
			await lb.upsert("alice", 100);

			expect(await lb.remove("alice")).toBe(true);
			expect(await lb.count()).toBe(0);
		});

		it("returns false for non-existent member", async () => {
			const lb = createBoard();
			expect(await lb.remove("nobody")).toBe(false);
		});
	});

	describe("count", () => {
		it("returns 0 for empty leaderboard", async () => {
			const lb = createBoard();
			expect(await lb.count()).toBe(0);
		});

		it("returns correct count after additions", async () => {
			const lb = createBoard();
			await seed(lb);
			expect(await lb.count()).toBe(5);
		});
	});

	describe("range", () => {
		it("returns members within a score range", async () => {
			const lb = createBoard();
			await seed(lb);

			const results = await lb.range(2000, 3000);
			expect(results).toHaveLength(2);

			const members = results.map((r) => r.member).sort();
			expect(members).toEqual(["alice", "bob"]);
		});

		it("includes correct ranks", async () => {
			const lb = createBoard();
			await seed(lb);

			const results = await lb.range(2000, 3000);
			// alice (2850) = rank 1, bob (2340) = rank 2 in highToLow
			const alice = results.find((r) => r.member === "alice");
			const bob = results.find((r) => r.member === "bob");
			expect(alice!.rank).toBe(1);
			expect(bob!.rank).toBe(2);
		});

		it("returns empty for range with no matches", async () => {
			const lb = createBoard();
			await seed(lb);
			expect(await lb.range(5000, 6000)).toEqual([]);
		});
	});
});
