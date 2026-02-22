# Cache

A Redis-backed cache with TTL, cache-aside pattern, stampede protection, and batch operations.

## Usage

```ts
import Redis from "ioredis";
import { Cache } from "upredis";

const redis = new Redis();
const cache = new Cache<User>({ redis, defaultTTL: 300 });

// Basic operations
await cache.set("user:42", { name: "alice", email: "alice@example.com" });
const user = await cache.get("user:42");
await cache.delete("user:42");
```

## Cache-Aside Pattern

The `getOrSet` method implements the cache-aside (lazy loading) pattern: check the cache first, and on a miss, call a loader function to fetch the data, cache it, and return it.

```ts
const user = await cache.getOrSet("user:42", async () => {
  // This only runs on cache miss
  return db.users.findById(42);
}, 300); // TTL in seconds
```

Your application code doesn't think about caching logic — it just says "get me this, here's how to fetch it if needed."

## Stampede Protection

When a popular cache key expires, many concurrent requests all see the miss and all hit the database simultaneously. This is the **thundering herd** (or cache stampede) problem.

`getOrSetSafe` solves this with a distributed lock:

```ts
const user = await cache.getOrSetSafe("user:42", async () => {
  return db.users.findById(42);
});
```

**What happens under the hood:**

1. Caller A sees a cache miss and acquires a lock (`SET key:lock NX EX 10`)
2. Callers B, C, D see the miss but can't acquire the lock — they poll and wait
3. Caller A loads from the database, writes to cache, releases the lock
4. Callers B, C, D find the cached value and return it

One database query instead of hundreds.

**If the lock holder crashes**, the lock auto-expires (via its TTL), and waiters fall back to loading the data themselves.

```ts
const user = await cache.getOrSetSafe("user:42", loader, {
  ttl: 300,            // cache TTL in seconds
  lockTTL: 10,         // lock auto-expires after 10s (safety net)
  waitTimeout: 5000,   // waiters give up after 5s
  retryInterval: 50,   // waiters poll every 50ms
});
```

## Batch Operations

`getMany`, `setMany`, and `deleteMany` use ioredis pipelines to batch multiple commands into a single network round trip.

```ts
// One round trip instead of three
const results = await cache.getMany(["user:1", "user:2", "user:3"]);
// Map { "user:1" => { name: "alice" }, "user:2" => null, "user:3" => { name: "charlie" } }

await cache.setMany([
  { key: "user:1", value: alice },
  { key: "user:2", value: bob, ttl: 60 },  // per-entry TTL
]);

const deletedCount = await cache.deleteMany(["user:1", "user:2"]);
```

## Custom Serialization

By default, values are serialized with `JSON.stringify` / `JSON.parse`. You can provide custom serializers for other formats:

```ts
import { pack, unpack } from "msgpackr";

const cache = new Cache<User>({
  redis,
  serialize: (value) => pack(value).toString("base64"),
  deserialize: (raw) => unpack(Buffer.from(raw, "base64")),
});
```

## API

### Constructor

```ts
new Cache<T>(config: CacheConfig)
```

The generic type `T` defines what type of values this cache stores. This gives you type safety on `get`, `set`, `getOrSet`, and all other methods.

### Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `redis` | `Redis` | *required* | ioredis client instance |
| `prefix` | `string` | `"cache"` | Key namespace prefix |
| `defaultTTL` | `number` | `undefined` | Default TTL in seconds (no expiry if unset) |
| `serialize` | `function` | `JSON.stringify` | Custom serializer |
| `deserialize` | `function` | `JSON.parse` | Custom deserializer |

### Methods

#### `get(key: string): Promise<T | null>`

Get a cached value. Returns `null` on cache miss.

#### `set(key: string, value: T, ttl?: number): Promise<void>`

Set a value. `ttl` overrides `defaultTTL` for this key.

#### `delete(key: string): Promise<boolean>`

Delete a key. Returns `true` if it existed.

#### `has(key: string): Promise<boolean>`

Check if a key exists.

#### `getOrSet(key: string, loader: () => Promise<T>, ttl?: number): Promise<T>`

Cache-aside: return cached value, or call `loader` on miss and cache the result.

No stampede protection — if 100 callers miss simultaneously, all 100 call the loader. Use `getOrSetSafe` when that matters.

#### `getOrSetSafe(key: string, loader: () => Promise<T>, options?): Promise<T>`

Cache-aside with stampede protection. Only one caller runs the loader; others wait for the result.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `ttl` | `number` | `defaultTTL` | TTL for the cached value |
| `lockTTL` | `number` | `10` | Lock auto-expiry in seconds |
| `waitTimeout` | `number` | `5000` | How long waiters poll (ms) |
| `retryInterval` | `number` | `50` | Poll interval (ms) |

#### `getMany(keys: string[]): Promise<Map<string, T | null>>`

Get multiple values in one round trip. Returns a Map with `null` for misses.

#### `setMany(entries: { key: string; value: T; ttl?: number }[]): Promise<void>`

Set multiple values in one round trip. Each entry can have its own TTL.

#### `deleteMany(keys: string[]): Promise<number>`

Delete multiple keys in one round trip. Returns the number of keys that were deleted.

## Example: REST API Cache Layer

```ts
import Redis from "ioredis";
import { Cache } from "upredis";

const redis = new Redis();
const userCache = new Cache<User>({ redis, defaultTTL: 300 });
const productCache = new Cache<Product>({ redis, defaultTTL: 60 });

// GET /users/:id
app.get("/users/:id", async (req, res) => {
  const user = await userCache.getOrSetSafe(
    `user:${req.params.id}`,
    () => db.users.findById(req.params.id),
  );
  res.json(user);
});

// PUT /users/:id — invalidate cache on write
app.put("/users/:id", async (req, res) => {
  const user = await db.users.update(req.params.id, req.body);
  await userCache.delete(`user:${req.params.id}`);
  res.json(user);
});

// GET /products — batch cache lookup
app.get("/products", async (req, res) => {
  const ids = req.query.ids as string[];
  const cached = await productCache.getMany(ids.map((id) => `product:${id}`));

  // Find which ones were cache misses
  const missingIds = ids.filter((id) => cached.get(`product:${id}`) === null);

  if (missingIds.length > 0) {
    const fresh = await db.products.findByIds(missingIds);
    await productCache.setMany(
      fresh.map((p) => ({ key: `product:${p.id}`, value: p })),
    );
    for (const p of fresh) {
      cached.set(`product:${p.id}`, p);
    }
  }

  res.json(ids.map((id) => cached.get(`product:${id}`)));
});
```

## When to Use `getOrSet` vs `getOrSetSafe`

| Scenario | Method |
|----------|--------|
| Low traffic, simple caching | `getOrSet` |
| High traffic, expensive loader (DB query, API call) | `getOrSetSafe` |
| Popular keys that many users hit simultaneously | `getOrSetSafe` |
| Loader is fast and idempotent (in-memory computation) | `getOrSet` |
