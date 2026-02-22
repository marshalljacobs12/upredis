-- Sliding window rate limiter (atomic)
--
-- How it works:
--   We store each request as a member in a sorted set, with its
--   timestamp (in milliseconds) as the score. To check the limit:
--   1. Remove all entries older than the window
--   2. Count remaining entries
--   3. If under the limit, add the new request
--   4. Refresh the key's TTL so it self-cleans
--
-- KEYS[1] = the sorted set key (e.g. "rl:user:42")
-- ARGV[1] = window start timestamp in ms (now - windowMs)
-- ARGV[2] = current timestamp in ms (now) — used as the score
-- ARGV[3] = limit (max requests per window)
-- ARGV[4] = unique request ID (score:random, to avoid collisions)
-- ARGV[5] = key TTL in seconds (= window duration)
--
-- Returns: { allowed (0/1), count after operation }

-- Step 1: Remove entries that have fallen outside the window.
-- '-inf' to windowStart covers everything older than our window.
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])

-- Step 2: How many requests are currently in the window?
local count = redis.call('ZCARD', KEYS[1])

local allowed = 0

-- Step 3: If under the limit, add this request to the set.
-- The score is the current timestamp; the member is a unique ID
-- so that two requests at the same millisecond don't collide.
if count < tonumber(ARGV[3]) then
    redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
    allowed = 1
    count = count + 1
end

-- Step 4: Set a TTL on the key so it eventually cleans itself up
-- even if no more requests come in. We set it to the full window
-- duration — any entry in the set will expire within this time.
redis.call('EXPIRE', KEYS[1], ARGV[5])

return { allowed, count }
