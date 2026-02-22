-- Token bucket rate limiter (atomic)
--
-- State is stored in a Redis hash with two fields:
--   tokens      — current number of tokens (float)
--   last_refill — timestamp in ms of the last refill calculation
--
-- On each call we:
--   1. Read current state (or initialize if new)
--   2. Calculate how many tokens to add based on elapsed time
--   3. Cap at capacity
--   4. If consuming: try to remove one token
--   5. Write back the new state
--
-- KEYS[1] = hash key (e.g. "rl:api:login")
-- ARGV[1] = capacity (max tokens)
-- ARGV[2] = refill rate (tokens per second)
-- ARGV[3] = current timestamp in ms
-- ARGV[4] = consume flag: "1" to consume a token, "0" to peek
--
-- Returns: { allowed (0/1), tokens remaining (as integer) }

local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local consume = ARGV[4] == "1"

-- Read current state from the hash
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens'))
local last_refill = tonumber(redis.call('HGET', KEYS[1], 'last_refill'))

-- If the key doesn't exist, initialize a full bucket
if tokens == nil then
    tokens = capacity
    last_refill = now_ms
end

-- Calculate how many tokens to add based on time elapsed
local elapsed_ms = now_ms - last_refill
local refill = (elapsed_ms / 1000) * refill_rate
tokens = math.min(capacity, tokens + refill)
last_refill = now_ms

-- Try to consume a token
local allowed = 0
if consume then
    if tokens >= 1 then
        tokens = tokens - 1
        allowed = 1
    end
else
    -- Peek mode: just report whether a token is available
    if tokens >= 1 then
        allowed = 1
    end
end

-- Write state back to the hash
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'last_refill', tostring(last_refill))

-- Set a TTL so the key cleans up if unused.
-- Time for a full refill from 0 = capacity / refill_rate seconds, plus buffer.
local ttl = math.ceil(capacity / refill_rate) + 10
redis.call('EXPIRE', KEYS[1], ttl)

-- Return tokens as a floored integer for the API
return { allowed, math.floor(tokens) }
