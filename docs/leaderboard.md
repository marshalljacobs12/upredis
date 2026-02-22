# Leaderboard

Sorted-set-backed rankings with O(log N) rank lookups. Supports high-to-low (points, kills) and low-to-high (race times, golf scores) ordering.

## Usage

```ts
import Redis from "ioredis";
import { Leaderboard } from "upredis";

const redis = new Redis();

const lb = new Leaderboard({
  redis,
  key: "weekly-scores",
});

// Add players
await lb.upsert("alice", 2850);
await lb.upsert("bob", 2340);
await lb.upsert("charlie", 1900);

// Increment a score (returns new score)
await lb.increment("alice", 150); // 3000

// Get rank + score
const entry = await lb.rank("alice");
// { member: "alice", score: 3000, rank: 0 }

// Top 10
const top = await lb.top(10);
// [{ member: "alice", score: 3000, rank: 0 }, ...]

// Players around a given player (2 above, 2 below)
const neighborhood = await lb.around("bob", 2);

// Players in a score range
const midTier = await lb.range(1000, 2000);

// Remove a player
await lb.remove("charlie"); // true

// Total players
await lb.count(); // 2
```

## Low-to-High Ordering

For leaderboards where lower is better (race times, golf scores):

```ts
const lb = new Leaderboard({
  redis,
  key: "speedrun-times",
  sortOrder: "lowToHigh",
});

await lb.upsert("alice", 42.5);  // 42.5 seconds
await lb.upsert("bob", 38.1);    // 38.1 seconds

const winner = await lb.top(1);
// [{ member: "bob", score: 38.1, rank: 0 }]
```

## Game Leaderboard Example

```ts
import Redis from "ioredis";
import { Leaderboard } from "upredis";
import express from "express";

const app = express();
const redis = new Redis();

const lb = new Leaderboard({ redis, key: "game-scores" });

// Submit a score after a game ends
app.post("/scores", async (req, res) => {
  const { playerId, score } = req.body;
  await lb.upsert(playerId, score);
  const entry = await lb.rank(playerId);
  res.json({ rank: entry?.rank, score: entry?.score });
});

// Get global top 100
app.get("/leaderboard", async (req, res) => {
  const top = await lb.top(100);
  res.json(top);
});

// Get a player's neighborhood (who's near them)
app.get("/leaderboard/:playerId/around", async (req, res) => {
  const neighborhood = await lb.around(req.params.playerId, 5);
  res.json(neighborhood);
});
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `redis` | `Redis` | *required* | ioredis client instance |
| `key` | `string` | *required* | Logical name for the leaderboard |
| `prefix` | `string` | `"lb"` | Key namespace prefix |
| `sortOrder` | `string` | `"highToLow"` | `"highToLow"` or `"lowToHigh"` |

## Methods

### `upsert(member: string, score: number): Promise<void>`

Add a member or replace their score. If the member already exists, their score is overwritten (not incremented).

### `increment(member: string, amount: number): Promise<number>`

Increment a member's score by `amount` (can be negative). Creates the member with the given amount if they don't exist. Returns the new score.

### `rank(member: string): Promise<LeaderboardEntry | null>`

Get a member's rank and score. Returns `null` if the member doesn't exist. Rank is 0-indexed (rank 0 = first place).

### `top(count: number): Promise<LeaderboardEntry[]>`

Get the top `count` members. Returns fewer if the leaderboard has fewer members.

### `around(member: string, count: number): Promise<LeaderboardEntry[]>`

Get the neighborhood around a member — up to `count` members above and `count` below, plus the member themselves. Returns an empty array if the member doesn't exist.

### `remove(member: string): Promise<boolean>`

Remove a member. Returns `true` if they existed, `false` otherwise.

### `count(): Promise<number>`

Total number of members in the leaderboard.

### `range(min: number, max: number): Promise<LeaderboardEntry[]>`

Get all members with scores between `min` and `max` (inclusive). Results include each member's actual rank in the full leaderboard.

## How It Works Under the Hood

The entire leaderboard is a single Redis sorted set. Members are unique strings, scores are floats. Redis keeps them sorted at all times using a skip list, giving O(log N) for inserts, deletes, and rank lookups.

| Method | Redis commands |
|--------|---------------|
| `upsert` | `ZADD` |
| `increment` | `ZINCRBY` |
| `rank` | `ZREVRANK` + `ZSCORE` (pipelined) |
| `top` | `ZREVRANGE ... WITHSCORES` |
| `around` | `ZREVRANK` then `ZREVRANGE ... WITHSCORES` |
| `remove` | `ZREM` |
| `count` | `ZCARD` |
| `range` | `ZRANGEBYSCORE ... WITHSCORES` + pipelined `ZREVRANK` for each result |

No Lua scripts are needed — each operation maps to one or two Redis commands with no conditional logic.
