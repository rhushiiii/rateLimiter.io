const LEAKY_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local leakRate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttlSec = tonumber(ARGV[5])

local data = redis.call("HMGET", key, "level", "last")
local level = tonumber(data[1])
local last = tonumber(data[2])

if level == nil then
  level = 0
  last = now
end

local elapsed = math.max(0, now - last) / 1000
level = math.max(0, level - elapsed * leakRate)

local allowed = 0
local retryMs = 0
if level + cost <= capacity then
  allowed = 1
  level = level + cost
else
  retryMs = math.ceil(((level + cost) - capacity) / leakRate * 1000)
end

redis.call("HSET", key, "level", level, "last", now)
redis.call("EXPIRE", key, ttlSec)

return {allowed, level, retryMs}
`;

let scriptSha = null;

async function consumeLeakyBucket(redis, key, policy) {
  const now = Date.now();
  const windowSec = Number(policy.windowSec || 60);
  const capacity = Number(policy.capacity || policy.limit || 100);
  const leakRate = Number(policy.leakRate || (policy.limit / windowSec));
  const cost = Number(policy.cost || 1);

  let result;
  try {
    if (!scriptSha) {
      scriptSha = await redis.script("LOAD", LEAKY_BUCKET_SCRIPT);
    }
    result = await redis.evalsha(scriptSha, 1, key, capacity, leakRate, now, cost, windowSec * 2);
  } catch (err) {
    if (err.message && err.message.includes("NOSCRIPT")) {
      scriptSha = null;
      return consumeLeakyBucket(redis, key, policy);
    }
    throw err;
  }

  const [allowedRaw, levelRaw, retryMsRaw] = result;
  const level = Number(levelRaw);
  const retryMs = Number(retryMsRaw);

  return {
    allowed: Number(allowedRaw) === 1,
    remaining: Math.max(0, Math.floor(capacity - level)),
    retryAfterSec: Number(allowedRaw) === 1 ? 0 : Math.ceil(retryMs / 1000),
    resetAfterSec: Number(allowedRaw) === 1 ? Math.ceil(windowSec) : Math.ceil(retryMs / 1000),
  };
}

module.exports = { consumeLeakyBucket };
