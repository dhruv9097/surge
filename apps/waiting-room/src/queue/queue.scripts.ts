/**
 * Virtual waiting room, computed on read.
 *
 * Every buyer gets a sequence number when they join. An admission watermark
 * advances at a fixed rate once the sale opens, and everyone whose number is
 * at or below it is admitted. The watermark is brought up to date atomically
 * by whichever request happens to look at it next, so there is no background
 * admitter, no leader election and nothing per-user to expire: any number of
 * waiting-room replicas can serve traffic, and the admission rate holds no
 * matter how many of them there are.
 *
 * The watermark never runs ahead of the queue. When the queue is empty,
 * newcomers are admitted almost at once; the queue only bites under load.
 *
 *   wr:{E}:seq       STR   last sequence number handed out
 *   wr:{E}:members   HASH  userId -> sequence number
 *   wr:{E}:gate      HASH  admitted (watermark), updatedAt (ms)
 */
export const QUEUE_STATUS = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local seq = redis.call('HGET', KEYS[2], ARGV[1])
if not seq then
  if ARGV[4] ~= '1' then
    return {'NOT_IN_QUEUE'}
  end
  seq = redis.call('INCR', KEYS[1])
  redis.call('HSET', KEYS[2], ARGV[1], seq)
  local ttl = tonumber(ARGV[5])
  redis.call('PEXPIRE', KEYS[1], ttl)
  redis.call('PEXPIRE', KEYS[2], ttl)
  redis.call('PEXPIRE', KEYS[3], ttl)
end
seq = tonumber(seq)

local total = tonumber(redis.call('GET', KEYS[1]) or '0')
local rate = tonumber(ARGV[2])
local opensAt = tonumber(ARGV[3])
local gate = redis.call('HMGET', KEYS[3], 'admitted', 'updatedAt')
local admitted = tonumber(gate[1] or '0')
local updatedAt = tonumber(gate[2] or '0')

if now > opensAt then
  local from = math.max(updatedAt, opensAt)
  admitted = math.min(admitted + rate * (now - from) / 1000, total)
  redis.call('HSET', KEYS[3], 'admitted', admitted, 'updatedAt', now)
end

return {'OK', seq, math.floor(admitted), total}
`;

export const queueKeys = (eventId: string) => {
  const base = `wr:{${eventId}}`;
  return { seq: `${base}:seq`, members: `${base}:members`, gate: `${base}:gate` };
};
