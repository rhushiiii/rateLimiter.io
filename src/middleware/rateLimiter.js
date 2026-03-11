const { PolicyStore } = require("../services/policyStore");
const { MetricsService } = require("../services/metricsService");
const { RateLimiterEngine } = require("../services/rateLimiterEngine");
const { RateLimiterService } = require("../services/rateLimiterService");

const policyStore = new PolicyStore();
const metricsService = new MetricsService();
const engine = new RateLimiterEngine();
const limiterService = new RateLimiterService({
  policyStore,
  engine,
  metricsService,
});

let initialized = false;

async function ensureInitialized() {
  if (initialized) return;
  await policyStore.init();
  initialized = true;
}

function distributedRateLimiter() {
  return async function rateLimiterMiddleware(req, res, next) {
    try {
      await ensureInitialized();

      const decision = await limiterService.decide(req);
      for (const [header, value] of Object.entries(decision.headers)) {
        res.setHeader(header, value);
      }

      if (!decision.allowed) {
        res.setHeader("Retry-After", String(decision.retryAfterSec || 1));
        return res.status(429).json({
          error: "Too Many Requests",
          message: "Rate limit exceeded",
          retryAfterSec: decision.retryAfterSec || 1,
          blockedBy: {
            policyId: decision.blockedBy?.policyId,
            algorithm: decision.blockedBy?.algorithm,
            scope: decision.blockedBy?.scope,
          },
        });
      }

      return next();
    } catch (err) {
      res.setHeader("X-RateLimit-Applied", "error-fallback");
      return next();
    }
  };
}

module.exports = {
  distributedRateLimiter,
  policyStore,
  metricsService,
};
