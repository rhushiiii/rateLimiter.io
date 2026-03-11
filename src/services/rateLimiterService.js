const { getMatchingPolicies } = require("../lib/policyMatcher");

class RateLimiterService {
  constructor({ policyStore, engine, metricsService }) {
    this.policyStore = policyStore;
    this.engine = engine;
    this.metricsService = metricsService;
  }

  async decide(req) {
    const started = process.hrtime.bigint();
    const policies = await this.policyStore.list();
    const matched = getMatchingPolicies(policies, req);

    if (matched.length === 0) {
      return {
        allowed: true,
        policyResults: [],
        headers: {
          "X-RateLimit-Applied": "none",
        },
      };
    }

    const results = [];
    for (const policy of matched) {
      const result = await this.engine.evaluate(policy, req);
      results.push(result);
      if (!result.allowed) break;
    }

    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    const final = results.find((r) => !r.allowed) || results[results.length - 1];

    await this.metricsService.record({
      allowed: !results.some((r) => !r.allowed),
      identifier: final?.identifier || "unknown",
      endpoint: req.path,
      latencyMs: elapsed,
    });

    return {
      allowed: !results.some((r) => !r.allowed),
      policyResults: results,
      headers: {
        "X-RateLimit-Limit": final ? String(matched.find((m) => m.id === final.policyId)?.limit || 0) : "0",
        "X-RateLimit-Remaining": final ? String(Math.max(0, final.remaining)) : "0",
        "X-RateLimit-Policy": final ? `${final.algorithm};scope=${final.scope}` : "none",
        "X-RateLimit-Reset": final ? String(final.resetAfterSec) : "0",
        "X-RateLimit-Latency-Ms": elapsed.toFixed(3),
      },
      retryAfterSec: final?.retryAfterSec || 0,
      blockedBy: final,
    };
  }
}

module.exports = { RateLimiterService };
