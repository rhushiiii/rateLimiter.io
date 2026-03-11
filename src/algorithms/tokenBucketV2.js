const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttlSec = tonumber(ARGV[5])

local data = redis.call("HMGET", key, "tokens", "last_refill")
local tokens = tonumber(data[1])
local lastRefill = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  lastRefill = now
end

local elapsed = math.max(0, now - lastRefill) / 1000
local refill = elapsed * refillRate
tokens = math.min(capacity, tokens + refill)

local allowed = 0
local retryMs = 0
if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
else
  retryMs = math.ceil((cost - tokens) / refillRate * 1000)
end

redis.call("HSET", key, "tokens", tokens, "last_refill", now)
redis.call("EXPIRE", key, ttlSec)

return {allowed, tokens, retryMs}
`;

let scriptSha = null;

async function consumeTokenBucket(redis, key, policy) {
  const now = Date.now();
  const windowSec = Number(policy.windowSec || 60);
  const capacity = Number(policy.capacity || policy.limit || 100);
  const refillRate = Number(policy.refillRate || (policy.limit / windowSec));
  const cost = Number(policy.cost || 1);

  let result;
  try {
    if (!scriptSha) {
      scriptSha = await redis.script("LOAD", TOKEN_BUCKET_SCRIPT);
    }
    result = await redis.evalsha(scriptSha, 1, key, capacity, refillRate, now, cost, windowSec * 2);
  } catch (err) {
    if (err.message && err.message.includes("NOSCRIPT")) {
      scriptSha = null;
      return consumeTokenBucket(redis, key, policy);
    }
    throw err;
  }

  const [allowedRaw, tokensRaw, retryMsRaw] = result;
  const tokens = Math.max(0, Math.floor(Number(tokensRaw)));
  const retryMs = Number(retryMsRaw);

  return {
    allowed: Number(allowedRaw) === 1,
    remaining: tokens,
    retryAfterSec: Number(allowedRaw) === 1 ? 0 : Math.ceil(retryMs / 1000),
    resetAfterSec: Number(allowedRaw) === 1 ? Math.ceil(windowSec) : Math.ceil(retryMs / 1000),
  };
}

module.exports = { consumeTokenBucket };
