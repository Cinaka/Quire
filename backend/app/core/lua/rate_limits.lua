-- Standalone Redis; all keys share one environment hash tag.
-- KEYS: bounded registry, event ZSET, login metadata HASH.
-- ARGV: operation, identity, limit, window_ms, max_keys, unique event/revision, expected_revision.
local op, ident = ARGV[1], ARGV[2]
local limit, window, capacity = tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])
local stamp = redis.call('TIME')
local now = tonumber(stamp[1]) * 1000 + math.floor(tonumber(stamp[2]) / 1000)
local function drop()
    redis.call('DEL', KEYS[2], KEYS[3])
    redis.call('ZREM', KEYS[1], ident)
end
local locked = tonumber(redis.call('HGET', KEYS[3], 'lock') or '0')
if locked > 0 and locked <= now then
    drop()
    locked = 0
end
if op == 'clear' then
    -- A successful request cannot erase a failure recorded after its initial check.
    local rev = redis.call('HGET', KEYS[3], 'rev') or ''
    if rev == ARGV[7] then drop() end
    return {0, 0, ''}
end
if locked > now then
    return {1, math.max(1, math.ceil((locked - now) / 1000)), ''}
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[2])
if op == 'check' then
    if count == 0 then drop() end
    return {0, 0, redis.call('HGET', KEYS[3], 'rev') or ''}
end
if op == 'consume' and count >= limit then
    local oldest = redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')
    return {1, math.max(1, math.ceil((tonumber(oldest[2]) + window - now) / 1000)), ''}
end
-- Registry is bounded independently for attempts and login failures. Do not evict live buckets.
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if not redis.call('ZSCORE', KEYS[1], ident) and redis.call('ZCARD', KEYS[1]) >= capacity then
    return {1, 60, ''}
end
redis.call('ZADD', KEYS[2], now, ARGV[6])
redis.call('PEXPIRE', KEYS[2], window)
redis.call('ZADD', KEYS[1], now + window, ident)
redis.call('PEXPIRE', KEYS[1], math.max(window, redis.call('PTTL', KEYS[1])))
if op == 'fail' then
    redis.call('HSET', KEYS[3], 'rev', ARGV[6])
    if count + 1 >= limit then
        redis.call('HSET', KEYS[3], 'lock', now + window)
    end
    redis.call('PEXPIRE', KEYS[3], window)
end
return {0, 0, ''}
