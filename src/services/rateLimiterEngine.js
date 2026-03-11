const { getRedisClient } = require("../redis/client");
const { scopeIdentifier } = require("../lib/requestIdentity");
const { consumeFixedWindow } = require("../algorithms/fixedWindow");
const { consumeSlidingWindow } = require("../algorithms/slidingWindow");
const { consumeTokenBucket } = require("../algorithms/tokenBucketV2");
const { consumeLeakyBucket } = require("../algorithms/leakyBucket");

class RateLimiterEngine {
  constructor(options = {}) {
    this.redis = getRedisClient();
    this.failStrategy = options.failStrategy || process.env.FAIL_STRATEGY || "fail_open";
  }

  async evaluate(policy, req) {
    const identifier = scopeIdentifier(policy.scope, req);
    const key = `rl:${policy.algorithm}:${policy.id}:${identifier}`;

    try {
      let decision;
      switch (policy.algorithm) {
        case "fixed_window":
          decision = await consumeFixedWindow(this.redis, key, policy);
          break;
        case "sliding_window":
          decision = await consumeSlidingWindow(this.redis, key, policy);
          break;
        case "token_bucket":
          decision = await consumeTokenBucket(this.redis, key, policy);
          break;
        case "leaky_bucket":
          decision = await consumeLeakyBucket(this.redis, key, policy);
          break;
        default:
          decision = await consumeFixedWindow(this.redis, key, policy);
      }

      return {
        ...decision,
        key,
        scope: policy.scope,
        identifier,
        policyId: policy.id,
        algorithm: policy.algorithm,
      };
    } catch (err) {
      const failOpen = this.failStrategy === "fail_open";
      return {
        allowed: failOpen,
        remaining: -1,
        retryAfterSec: 0,
        resetAfterSec: 0,
        key,
        scope: policy.scope,
        identifier,
        policyId: policy.id,
        algorithm: policy.algorithm,
        error: err.message,
      };
    }
  }
}

module.exports = { RateLimiterEngine };
