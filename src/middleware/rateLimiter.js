const { TokenBucket } = require("../algorithms/tokenBucket");

/**
 * createRateLimiter(options)
 * Returns Express middleware that enforces rate limits using token bucket algorithm.
 */
function createRateLimiter(options = {}) {
  const {
    capacity = 100,
    refillRate = 10,
    cost = 1,
    keyGenerator = defaultKeyGenerator,
    onLimited = defaultOnLimited,
    keyPrefix = "",
  } = options;

  const bucket = new TokenBucket({ capacity, refillRate, cost });

  return async function rateLimiterMiddleware(req, res, next) {
    const rawKey = keyGenerator(req);
    const key = keyPrefix ? `${keyPrefix}:${rawKey}` : rawKey;

    const result = await bucket.consume(key, cost);

    res.setHeader("X-RateLimit-Limit", capacity);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, result.remaining));
    res.setHeader("X-RateLimit-Policy", `${capacity};w=${Math.ceil(capacity / refillRate)}`);

    if (!result.allowed) {
      res.setHeader("Retry-After", result.retryAfter);
      res.setHeader("X-RateLimit-Reset", result.resetAt || "");
      return onLimited(req, res, result);
    }

    next();
  };
}

function defaultKeyGenerator(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = forwarded
    ? forwarded.split(",")[0].trim()
    : req.socket?.remoteAddress || "unknown";
  return ip;
}

function defaultOnLimited(req, res, result) {
  return res.status(429).json({
    error: "Too Many Requests",
    message: `Rate limit exceeded. Try again in ${result.retryAfter}s.`,
    retryAfter: result.retryAfter,
    resetAt: result.resetAt,
  });
}

const strictLimiter = createRateLimiter({
  capacity: 20,
  refillRate: 20 / 60,
  keyPrefix: "strict",
});

const standardLimiter = createRateLimiter({
  capacity: 100,
  refillRate: 100 / 60,
  keyPrefix: "standard",
});

const lenientLimiter = createRateLimiter({
  capacity: 1000,
  refillRate: 1000 / 60,
  keyPrefix: "lenient",
});

const apiKeyLimiter = createRateLimiter({
  capacity: 500,
  refillRate: 500 / 60,
  keyGenerator: (req) => {
    const auth = req.headers["authorization"] || req.headers["x-api-key"];
    return auth ? `apikey:${auth}` : defaultKeyGenerator(req);
  },
  keyPrefix: "apikey",
});

module.exports = {
  createRateLimiter,
  strictLimiter,
  standardLimiter,
  lenientLimiter,
  apiKeyLimiter,
};
