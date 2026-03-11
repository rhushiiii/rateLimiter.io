const { getRedisClient } = require("../redis/client");

const METRIC_PREFIX = "rl:metrics";

class MetricsService {
  constructor() {
    this.redis = getRedisClient();
  }

  async record(decision) {
    const now = Date.now();
    const minuteBucket = Math.floor(now / 60000);
    const endpointKey = `${METRIC_PREFIX}:endpoint:${decision.endpoint}`;
    const latencyBucket = `${METRIC_PREFIX}:latency:${minuteBucket}`;

    const p = this.redis.pipeline();
    p.incr(`${METRIC_PREFIX}:requests_total`);
    if (!decision.allowed) p.incr(`${METRIC_PREFIX}:rate_limited_total`);
    p.pfadd(`${METRIC_PREFIX}:active_clients`, decision.identifier);
    p.hincrby(endpointKey, "requests_total", 1);
    p.hincrby(endpointKey, decision.allowed ? "allowed_total" : "limited_total", 1);
    p.hset(`${METRIC_PREFIX}:last`, "timestamp", now);
    p.rpush(latencyBucket, decision.latencyMs.toString());
    p.expire(latencyBucket, 600);
    p.expire(endpointKey, 3600);
    try {
      await p.exec();
    } catch (err) {
      // Metrics must never block request processing.
    }
  }

  async snapshot() {
    const now = Date.now();
    const minuteBucket = Math.floor(now / 60000);
    const latencyKey = `${METRIC_PREFIX}:latency:${minuteBucket}`;

    let requestsTotal = 0;
    let rateLimitedTotal = 0;
    let activeClients = 0;
    let endpoints = [];
    let latencies = [];

    try {
      [
        requestsTotal,
        rateLimitedTotal,
        activeClients,
        endpoints,
        latencies,
      ] = await Promise.all([
        this.redis.get(`${METRIC_PREFIX}:requests_total`),
        this.redis.get(`${METRIC_PREFIX}:rate_limited_total`),
        this.redis.pfcount(`${METRIC_PREFIX}:active_clients`),
        this.redis.keys(`${METRIC_PREFIX}:endpoint:*`),
        this.redis.lrange(latencyKey, 0, -1),
      ]);
    } catch (err) {
      return {
        requests_total: 0,
        rate_limited_total: 0,
        active_clients: 0,
        latency_ms: { p50: 0, p95: 0, p99: 0 },
        endpoints: {},
        timestamp: new Date(now).toISOString(),
      };
    }

    const endpointStats = {};
    if (endpoints.length > 0) {
      const p = this.redis.pipeline();
      endpoints.forEach((key) => p.hgetall(key));
      const rows = await p.exec();
      endpoints.forEach((key, idx) => {
        endpointStats[key.replace(`${METRIC_PREFIX}:endpoint:`, "")] = rows[idx][1] || {};
      });
    }

    const latencyNumbers = latencies.map(Number).filter((v) => !Number.isNaN(v));
    latencyNumbers.sort((a, b) => a - b);

    return {
      requests_total: Number(requestsTotal || 0),
      rate_limited_total: Number(rateLimitedTotal || 0),
      active_clients: Number(activeClients || 0),
      latency_ms: {
        p50: percentile(latencyNumbers, 0.5),
        p95: percentile(latencyNumbers, 0.95),
        p99: percentile(latencyNumbers, 0.99),
      },
      endpoints: endpointStats,
      timestamp: new Date(now).toISOString(),
    };
  }

  async prometheus() {
    const snap = await this.snapshot();
    return [
      "# HELP requests_total Total requests seen by rate limiter",
      "# TYPE requests_total counter",
      `requests_total ${snap.requests_total}`,
      "# HELP rate_limited_total Requests blocked by rate limiter",
      "# TYPE rate_limited_total counter",
      `rate_limited_total ${snap.rate_limited_total}`,
      "# HELP active_clients Approx unique active clients",
      "# TYPE active_clients gauge",
      `active_clients ${snap.active_clients}`,
      "# HELP rate_limiter_latency_p95_ms Decision overhead p95",
      "# TYPE rate_limiter_latency_p95_ms gauge",
      `rate_limiter_latency_p95_ms ${snap.latency_ms.p95}`,
    ].join("\n");
  }
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const idx = Math.min(arr.length - 1, Math.floor(arr.length * p));
  return Number(arr[idx].toFixed(3));
}

module.exports = { MetricsService };
