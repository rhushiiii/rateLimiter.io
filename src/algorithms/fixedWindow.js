const FIXED_WINDOW_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local ttlSec = tonumber(ARGV[2])
local current = redis.call("INCR", key)
if current == 1 then
  redis.call("EXPIRE", key, ttlSec)
end
local ttl = redis.call("TTL", key)
local allowed = 0
if current <= limit then
  allowed = 1
end
return {allowed, current, ttl}
`;

let scriptSha = null;

async function consumeFixedWindow(redis, key, policy) {
  const windowSec = Number(policy.windowSec || 60);
  const nowSec = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(nowSec / windowSec);
  const bucketKey = `${key}:${bucket}`;

  let result;
  try {
    if (!scriptSha) {
      scriptSha = await redis.script("LOAD", FIXED_WINDOW_SCRIPT);
    }
    result = await redis.evalsha(scriptSha, 1, bucketKey, policy.limit, windowSec + 1);
  } catch (err) {
    if (err.message && err.message.includes("NOSCRIPT")) {
      scriptSha = null;
      return consumeFixedWindow(redis, key, policy);
    }
    throw err;
  }

  const [allowedRaw, currentRaw, ttlRaw] = result;
  const current = Number(currentRaw);
  const ttl = Number(ttlRaw);

  return {
    allowed: Number(allowedRaw) === 1,
    remaining: Math.max(0, Number(policy.limit) - current),
    retryAfterSec: Number(allowedRaw) === 1 ? 0 : Math.max(1, ttl),
    resetAfterSec: Math.max(1, ttl),
  };
}

module.exports = { consumeFixedWindow };
