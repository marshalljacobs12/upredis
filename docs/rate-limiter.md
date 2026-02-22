# RateLimiter

Three algorithms behind one API. Pick the strategy that fits your use case, swap it later without changing your application code.

## Strategies at a Glance

| Strategy | How it works | Best for |
|----------|-------------|----------|
| **Fixed window** | Counts requests in discrete time buckets using `INCR` + `EXPIRE` | Simple quotas, lowest overhead |
| **Sliding window** | Tracks each request timestamp in a sorted set, prunes expired entries atomically via Lua | Accurate rate limiting without boundary burst issues |
| **Token bucket** | Maintains a refilling token pool in a hash via Lua | APIs that need to allow short bursts while enforcing an average rate |

## Usage

### Sliding Window (recommended default)

```ts
import Redis from "ioredis";
import { RateLimiter } from "upredis";

const redis = new Redis();

const limiter = new RateLimiter({
  redis,
  strategy: "sliding-window",
  limit: 100,
  window: 60,
});

const result = await limiter.limit("user:42");

if (!result.allowed) {
  res.setHeader("Retry-After", result.retryAfter);
  res.status(429).json({ error: "Too many requests" });
  return;
}
```

### Fixed Window

```ts
const limiter = new RateLimiter({
  redis,
  strategy: "fixed-window",
  limit: 1000,
  window: 3600, // 1000 requests per hour
});
```

**Trade-off:** Simpler and faster (two Redis commands, no Lua), but allows up to 2x the limit at window boundaries. If a user sends 1000 requests at `t=3599` and 1000 more at `t=3600`, both windows pass — that's 2000 requests in 2 seconds.

### Token Bucket

```ts
const limiter = new RateLimiter({
  redis,
  strategy: "token-bucket",
  capacity: 10,     // max burst of 10 requests
  refillRate: 2,    // refills 2 tokens per second
});
```

**Trade-off:** Allows bursts up to `capacity`, then throttles to `refillRate` per second until tokens refill. Good for APIs where occasional bursts are acceptable but sustained overuse isn't.

## Express Middleware Example

```ts
import Redis from "ioredis";
import { RateLimiter } from "upredis";
import express from "express";

const app = express();
const redis = new Redis();

const limiter = new RateLimiter({
  redis,
  strategy: "sliding-window",
  limit: 100,
  window: 60,
});

app.use(async (req, res, next) => {
  // Key by IP, or by authenticated user ID
  const key = req.ip ?? "anonymous";
  const result = await limiter.limit(key);

  // Always set rate limit headers so clients can self-throttle
  res.setHeader("X-RateLimit-Limit", result.limit);
  res.setHeader("X-RateLimit-Remaining", result.remaining);

  if (!result.allowed) {
    res.setHeader("Retry-After", result.retryAfter);
    res.status(429).json({ error: "Too many requests" });
    return;
  }

  next();
});
```

## Configuration

### Fixed Window / Sliding Window

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `redis` | `Redis` | *required* | ioredis client instance |
| `strategy` | `"fixed-window"` \| `"sliding-window"` | *required* | Algorithm to use |
| `limit` | `number` | *required* | Max requests per window |
| `window` | `number` | *required* | Window duration in seconds |
| `prefix` | `string` | `"rl"` | Key namespace prefix |

### Token Bucket

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `redis` | `Redis` | *required* | ioredis client instance |
| `strategy` | `"token-bucket"` | *required* | Algorithm to use |
| `capacity` | `number` | *required* | Max tokens the bucket holds (burst size) |
| `refillRate` | `number` | *required* | Tokens added per second |
| `prefix` | `string` | `"rl"` | Key namespace prefix |

## Methods

### `limit(key: string): Promise<RateLimitResult>`

Check if a request is allowed and **consume one unit**. Call this on every incoming request.

### `peek(key: string): Promise<RateLimitResult>`

Check the current state **without consuming**. Useful for displaying remaining quota to users (e.g. in a dashboard) without burning a request.

### `reset(key: string): Promise<void>`

Clear all rate limit state for a key. The next `limit()` call starts fresh.

## Return Type: `RateLimitResult`

| Field | Type | Description |
|-------|------|-------------|
| `allowed` | `boolean` | Whether the request is allowed |
| `remaining` | `number` | Remaining requests / tokens |
| `limit` | `number` | The configured limit / capacity |
| `retryAfter` | `number` | Seconds until next allowed request (0 if allowed) |

## How It Works Under the Hood

### Fixed Window

Each window gets a unique Redis string key (e.g. `rl:user:42:1708617600`). `INCR` atomically increments the counter; `EXPIRE` ensures the key self-destructs when the window ends. Two commands, no Lua.

### Sliding Window

Each request is stored as a member in a Redis sorted set, scored by its timestamp in milliseconds. A Lua script atomically: removes entries outside the window (`ZREMRANGEBYSCORE`), counts remaining entries (`ZCARD`), conditionally adds the new request (`ZADD`), and refreshes the key TTL (`EXPIRE`).

### Token Bucket

State is stored in a Redis hash with two fields: `tokens` (current count) and `last_refill` (timestamp). A Lua script atomically: reads the hash, calculates token refill based on elapsed time, caps at capacity, attempts to consume one token, and writes the new state back.
