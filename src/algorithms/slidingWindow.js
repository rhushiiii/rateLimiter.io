const { randomUUID } = require("crypto");

const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call("ZREMRANGEBYSCORE", key, 0, now - windowMs)
local current = redis.call("ZCARD", key)
if current < limit then
  redis.call("ZADD", key, now, member)
  redis.call("PEXPIRE", key, windowMs * 2)
  return {1, current + 1, 0}
end

local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
local retryMs = windowMs
if oldest[2] then
  retryMs = math.max(1, (oldest[2] + windowMs) - now)
end
return {0, current, retryMs}
`;

let scriptSha = null;

async function consumeSlidingWindow(redis, key, policy) {
  const now = Date.now();
  const windowMs = Number(policy.windowSec || 60) * 1000;
  const member = `${now}:${randomUUID()}`;

  let result;
  try {
    if (!scriptSha) {
      scriptSha = await redis.script("LOAD", SLIDING_WINDOW_SCRIPT);
    }
    result = await redis.evalsha(scriptSha, 1, key, now, windowMs, policy.limit, member);
  } catch (err) {
    if (err.message && err.message.includes("NOSCRIPT")) {
      scriptSha = null;
      return consumeSlidingWindow(redis, key, policy);
    }
    throw err;
  }

  const [allowedRaw, usedRaw, retryMsRaw] = result;
  const used = Number(usedRaw);
  const retryMs = Number(retryMsRaw);

  return {
    allowed: Number(allowedRaw) === 1,
    remaining: Math.max(0, Number(policy.limit) - used),
    retryAfterSec: Number(allowedRaw) === 1 ? 0 : Math.ceil(retryMs / 1000),
    resetAfterSec: Number(allowedRaw) === 1 ? Math.ceil(windowMs / 1000) : Math.ceil(retryMs / 1000),
  };
}

module.exports = { consumeSlidingWindow };
