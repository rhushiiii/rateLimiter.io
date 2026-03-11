/**
 * Token Bucket Rate Limiter
 * 
 * Uses Redis + Lua scripts for atomic operations, ensuring correctness
 * across distributed nodes with no race conditions.
 * 
 * Algorithm:
 *  - Each client gets a "bucket" with a max capacity of tokens
 *  - Tokens refill at a fixed rate over time
 *  - Each request consumes N tokens
 *  - If bucket is empty → request is rejected (429)
 */

const { getClient } = require('../utils/redis');

// Lua script executed atomically in Redis
// This prevents race conditions when multiple nodes check the same bucket
const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local refill_interval = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local now = tonumber(ARGV[5])
local ttl = tonumber(ARGV[6])

-- Get current bucket state
local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(bucket[1])
local last_refill = tonumber(bucket[2])

-- Initialize bucket if it doesn't exist
if tokens == nil then
  tokens = capacity
  last_refill = now
end

-- Calculate how many tokens to add since last refill
local elapsed = now - last_refill
local intervals_passed = math.floor(elapsed / refill_interval)
local new_tokens = intervals_passed * refill_rate

if new_tokens > 0 then
  tokens = math.min(capacity, tokens + new_tokens)
  last_refill = last_refill + (intervals_passed * refill_interval)
end

-- Check if request can be fulfilled
local allowed = 0
local remaining = tokens

if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
  remaining = tokens
end

-- Persist updated bucket state
redis.call('HMSET', key, 'tokens', tokens, 'last_refill', last_refill)
redis.call('EXPIRE', key, ttl)

-- Return: allowed, remaining tokens, capacity, reset time (ms until full)
local tokens_needed = capacity - tokens
local refills_needed = math.ceil(tokens_needed / refill_rate)
local reset_ms = refills_needed * refill_interval

return {allowed, math.floor(remaining), capacity, reset_ms, last_refill}
`;

class TokenBucketLimiter {
  constructor(options = {}) {
    this.capacity = options.capacity || parseInt(process.env.DEFAULT_BUCKET_CAPACITY) || 100;
    this.refillRate = options.refillRate || parseInt(process.env.DEFAULT_REFILL_RATE) || 10;
    this.refillInterval = options.refillInterval || parseInt(process.env.DEFAULT_REFILL_INTERVAL) || 1000;
    this.cost = options.cost || parseInt(process.env.DEFAULT_COST_PER_REQUEST) || 1;
    this.keyPrefix = options.keyPrefix || 'rl:bucket';
    this.ttl = options.ttl || 3600; // 1 hour TTL on idle buckets

    this.redis = getClient();
    this._scriptSha = null;
  }

  /**
   * Load Lua script into Redis for efficient re-execution (EVALSHA)
   */
  async _loadScript() {
    if (!this._scriptSha) {
      this._scriptSha = await this.redis.script('LOAD', TOKEN_BUCKET_SCRIPT);
    }
    return this._scriptSha;
  }

  /**
   * Build a namespaced Redis key for a client identifier
   */
  _buildKey(identifier, endpoint = 'global') {
    return `${this.keyPrefix}:${endpoint}:${identifier}`;
  }

  /**
   * Check & consume tokens for a given client
   * @returns {Object} { allowed, remaining, capacity, resetMs, retryAfter }
   */
  async consume(identifier, options = {}) {
    const {
      endpoint = 'global',
      cost = this.cost,
      capacity = this.capacity,
      refillRate = this.refillRate,
      refillInterval = this.refillInterval,
    } = options;

    const key = this._buildKey(identifier, endpoint);
    const now = Date.now();

    try {
      const sha = await this._loadScript();

      const result = await this.redis.evalsha(
        sha, 1, key,
        capacity, refillRate, refillInterval,
        cost, now, this.ttl
      );

      const [allowed, remaining, cap, resetMs] = result;

      return {
        allowed: allowed === 1,
        remaining: remaining,
        capacity: cap,
        resetMs: resetMs,
        retryAfter: allowed === 0 ? Math.ceil(resetMs / 1000) : 0,
        key,
      };

    } catch (err) {
      // If EVALSHA fails (script evicted), reload and retry
      if (err.message.includes('NOSCRIPT')) {
        this._scriptSha = null;
        return this.consume(identifier, options);
      }

      // Fail open: allow request if Redis is down (availability > safety)
      console.error('[RateLimiter] Redis error, failing open:', err.message);
      return {
        allowed: true,
        remaining: -1,
        capacity: capacity,
        resetMs: 0,
        retryAfter: 0,
        error: 'redis_unavailable',
      };
    }
  }

  /**
   * Peek at bucket state without consuming tokens
   */
  async peek(identifier, endpoint = 'global') {
    const key = this._buildKey(identifier, endpoint);
    const data = await this.redis.hgetall(key);

    if (!data || !data.tokens) {
      return { tokens: this.capacity, lastRefill: Date.now(), exists: false };
    }

    return {
      tokens: parseFloat(data.tokens),
      lastRefill: parseInt(data.last_refill),
      exists: true,
    };
  }

  /**
   * Reset a client's bucket (admin use)
   */
  async reset(identifier, endpoint = 'global') {
    const key = this._buildKey(identifier, endpoint);
    await this.redis.del(key);
    return { reset: true, key };
  }

  /**
   * Get all active rate limit keys matching a pattern
   */
  async getActiveBuckets(pattern = '*') {
    const keys = await this.redis.keys(`${this.keyPrefix}:${pattern}`);
    return keys;
  }
}

module.exports = TokenBucketLimiter;
