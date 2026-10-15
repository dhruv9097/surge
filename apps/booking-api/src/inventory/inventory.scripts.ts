/**
 * Redis Lua scripts for seat inventory. Each script runs atomically on the
 * Redis server, so check-then-act sequences ("is this seat free? then take
 * it") cannot interleave between concurrent buyers.
 *
 * Every key for an event shares the `{eventId}` hash tag, so all of an event's
 * keys live in one slot and the scripts stay valid on Redis Cluster.
 *
 *   ev:{E}:seats       SET   every seat id that exists for the event
 *   ev:{E}:sold        SET   seats sold (mirrors seat_sales in Postgres)
 *   ev:{E}:held        ZSET  seat id -> hold expiry (ms since epoch)
 *   ev:{E}:hold:{H}    HASH  userId, seats, expiresAt         (TTL = hold)
 *   ev:{E}:user:{U}    STR   the user's active hold id         (TTL = hold)
 *
 * Time comes from the Redis server clock (TIME), never from app instances,
 * so clock skew between replicas cannot extend or cut short a hold.
 */

const NOW_MS = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
`;

/**
 * KEYS: seats, sold, held, holdKey, userKey
 * ARGV: holdId, userId, ttlMs, seatId...
 * Returns {'OK', expiresAt} or {'ERR_<REASON>', ...detail}
 */
export const HOLD_SEATS = `${NOW_MS}
if redis.call('EXISTS', KEYS[1]) == 0 then
  return {'ERR_NOT_LOADED'}
end
local existing = redis.call('GET', KEYS[5])
if existing then
  return {'ERR_ALREADY_HOLDING', existing}
end

-- Drop expired holds so their seats count as free again.
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)

local unavailable = {}
for i = 4, #ARGV do
  local seat = ARGV[i]
  if redis.call('SISMEMBER', KEYS[1], seat) == 0 then
    return {'ERR_UNKNOWN_SEAT', seat}
  end
  if redis.call('SISMEMBER', KEYS[2], seat) == 1 or redis.call('ZSCORE', KEYS[3], seat) then
    table.insert(unavailable, seat)
  end
end
if #unavailable > 0 then
  return {'ERR_UNAVAILABLE', unpack(unavailable)}
end

-- All-or-nothing: only reached when every requested seat is free.
local ttl = tonumber(ARGV[3])
local expiresAt = now + ttl
local seats = {}
for i = 4, #ARGV do
  redis.call('ZADD', KEYS[3], expiresAt, ARGV[i])
  table.insert(seats, ARGV[i])
end
redis.call('HSET', KEYS[4], 'userId', ARGV[2], 'seats', table.concat(seats, ','), 'expiresAt', expiresAt)
redis.call('PEXPIRE', KEYS[4], ttl)
redis.call('SET', KEYS[5], ARGV[1], 'PX', ttl)
return {'OK', tostring(expiresAt)}
`;

/**
 * Removes this hold's entries from the held set. An entry is only removed if
 * its expiry still matches this hold, so a seat that was already re-held by
 * someone else after this hold lapsed is never released by mistake.
 */
const RELEASE_HELD_ENTRIES = `
local function releaseHeld(heldKey, seatsCsv, expiresAt)
  if not seatsCsv or not expiresAt then return end
  for seat in string.gmatch(seatsCsv, '[^,]+') do
    if redis.call('ZSCORE', heldKey, seat) == expiresAt then
      redis.call('ZREM', heldKey, seat)
    end
  end
end
`;

/**
 * KEYS: held, holdKey, userKey
 * ARGV: userId, holdId
 * Returns 'OK' or 'ERR_NOT_FOUND' (missing, expired, or another user's hold)
 */
export const RELEASE_HOLD = `${RELEASE_HELD_ENTRIES}
local hold = redis.call('HMGET', KEYS[2], 'userId', 'seats', 'expiresAt')
if not hold[1] or hold[1] ~= ARGV[1] then
  return 'ERR_NOT_FOUND'
end
releaseHeld(KEYS[1], hold[2], hold[3])
redis.call('DEL', KEYS[2])
if redis.call('GET', KEYS[3]) == ARGV[2] then
  redis.call('DEL', KEYS[3])
end
return 'OK'
`;

/**
 * Called after the order is committed in Postgres: marks the seats sold and
 * retires the hold. Seats come from the order, not the hold, so this still
 * works if the hold expired while the database transaction was running.
 *
 * KEYS: held, sold, holdKey, userKey
 * ARGV: holdId, seatId...
 */
export const COMMIT_HOLD = `${RELEASE_HELD_ENTRIES}
local hold = redis.call('HMGET', KEYS[3], 'userId', 'seats', 'expiresAt')
for i = 2, #ARGV do
  redis.call('SADD', KEYS[2], ARGV[i])
end
releaseHeld(KEYS[1], hold[2], hold[3])
redis.call('DEL', KEYS[3])
if redis.call('GET', KEYS[4]) == ARGV[1] then
  redis.call('DEL', KEYS[4])
end
return 'OK'
`;

export const inventoryKeys = (eventId: string) => {
  const base = `ev:{${eventId}}`;
  return {
    seats: `${base}:seats`,
    sold: `${base}:sold`,
    held: `${base}:held`,
    hold: (holdId: string) => `${base}:hold:${holdId}`,
    user: (userId: string) => `${base}:user:${userId}`,
  };
};
