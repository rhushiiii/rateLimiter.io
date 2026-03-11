const { getRedisClient } = require("../redis/client");

/**
 * Token Bucket Algorithm (Redis-backed, atomic via Lua)
 *
 * Each bucket has:
 *   - tokens: current available tokens
 *   - last_refill: UNIX timestamp (ms) of last refill
 *
 * On each request:
 *   1. Calculate time elapsed since last refill
 *   2. Add (elapsed * refillRate) tokens (capped at capacity)
 *   3. If tokens >= cost, deduct and allow — else deny
 *
 * The Lua script runs atomically on Redis, so no race conditions
 * even across multiple Node.js instances.
 */

// Lua script for atomic token bucket check-and-consume
const TOKEN_BUCKET_SCRIPT = `
local key         = KEYS[1]
local capacity    = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])   -- tokens per second
local now         = tonumber(ARGV[3])   -- current time in ms
local cost        = tonumber(ARGV[4])   -- tokens this request costs
local ttl         = tonumber(ARGV[5])   -- key expiry in seconds

-- Load existing bucket state
local bucket = redis.call("HMGET", key, "tokens", "last_refill")
local tokens      = tonumber(bucket[1])
local last_refill = tonumber(bucket[2])

-- Initialize bucket if it doesn't exist
if tokens == nil then
  tokens      = capacity
  last_refill = now
end

-- Refill: add tokens proportional to elapsed time
local elapsed       = math.max(0, now - last_refill) / 1000  -- convert ms -> seconds
local refill_amount = elapsed * refill_rate
tokens = math.min(capacity, tokens + refill_amount)

local allowed    = 0
local remaining  = math.floor(tokens)
local retry_after = 0

if tokens >= cost then
  tokens   = tokens - cost
  allowed  = 1
  remaining = math.floor(tokens)
else
  -- How long until enough tokens refill
  retry_after = math.ceil((cost - tokens) / refill_rate * 1000)  -- ms
end

-- Persist updated bucket
redis.call("HSET", key, "tokens", tokens, "last_refill", now)
redis.call("EXPIRE", key, ttl)

return { allowed, remaining, retry_after }
`;

class TokenBucket {
  constructor(options = {}) {
    this.capacity = options.capacity || 100; // max tokens
    this.refillRate = options.refillRate || 10; // tokens per second
    this.cost = options.cost || 1; // tokens per request
    this.ttl = options.ttl || 3600; // key TTL in seconds (1 hour)
    this.redis = getRedisClient();

    // Register the Lua script with Redis for efficiency
    this.scriptSha = null;
    this._loadScript();
  }

  async _loadScript() {
    try {
      this.scriptSha = await this.redis.script("LOAD", TOKEN_BUCKET_SCRIPT);
    } catch (err) {
      console.warn("[TokenBucket] Could not pre-load Lua script:", err.message);
    }
  }

  /**
   * Attempt to consume tokens for a given key (e.g., IP address, API key, user ID)
   * @returns { allowed, remaining, retryAfter, resetAt }
   */
  async consume(key, cost = this.cost) {
    const now = Date.now();
    const bucketKey = `rl:bucket:${key}`;

    let result;
    try {
      if (this.scriptSha) {
        result = await this.redis.evalsha(
          this.scriptSha,
          1,
          bucketKey,
          this.capacity,
          this.refillRate,
          now,
          cost,
          this.ttl
        );
      } else {
        result = await this.redis.eval(
          TOKEN_BUCKET_SCRIPT,
          1,
          bucketKey,
          this.capacity,
          this.refillRate,
          now,
          cost,
          this.ttl
        );
      }
    } catch (err) {
      // If Redis is down, fail open (allow request) to avoid blocking all traffic
      console.error("[TokenBucket] Redis error, failing open:", err.message);
      return { allowed: true, remaining: -1, retryAfter: 0, resetAt: null };
    }

    const [allowed, remaining, retryAfter] = result;
    const resetAt = allowed
      ? null
      : new Date(now + retryAfter).toISOString();

    return {
      allowed: allowed === 1,
      remaining,
      retryAfter: Math.ceil(retryAfter / 1000), // convert to seconds for headers
      resetAt,
      capacity: this.capacity,
    };
  }

  /**
   * Peek at bucket state without consuming tokens
   */
  async peek(key) {
    const bucketKey = `rl:bucket:${key}`;
    const bucket = await this.redis.hgetall(bucketKey);
    if (!bucket || !bucket.tokens) {
      return { tokens: this.capacity, capacity: this.capacity };
    }
    const elapsed = (Date.now() - Number(bucket.last_refill)) / 1000;
    const current = Math.min(
      this.capacity,
      Number(bucket.tokens) + elapsed * this.refillRate
    );
    return { tokens: Math.floor(current), capacity: this.capacity };
  }
}

module.exports = { TokenBucket };
