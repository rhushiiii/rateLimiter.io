/**
 * Distributed Metrics Collector
 * 
 * Tracks request statistics across all nodes using Redis atomic increments.
 * Provides sliding window metrics for the dashboard.
 */

const { getClient } = require('./redis');

const METRICS_KEY = 'rl:metrics';
const TIMELINE_KEY = 'rl:timeline';
const BLOCKED_KEY = 'rl:blocked';

class MetricsCollector {
  constructor() {
    this.redis = getClient();
    this.windowMs = parseInt(process.env.METRICS_WINDOW) || 60000;
    this.localBuffer = []; // Buffer for timeline events
    this.flushInterval = setInterval(() => this._flush(), 1000);
  }

  async record(event) {
    const { allowed, identifier, endpoint, remaining, node } = event;
    const now = Date.now();

    const pipeline = this.redis.pipeline();

    // Increment global counters
    pipeline.hincrby(METRICS_KEY, 'total_requests', 1);
    pipeline.hincrby(METRICS_KEY, allowed ? 'allowed_requests' : 'blocked_requests', 1);
    pipeline.hset(METRICS_KEY, 'last_updated', now);

    // Per-endpoint counters
    pipeline.hincrby(`${METRICS_KEY}:endpoint:${endpoint}`, 'total', 1);
    pipeline.hincrby(`${METRICS_KEY}:endpoint:${endpoint}`, allowed ? 'allowed' : 'blocked', 1);
    pipeline.expire(`${METRICS_KEY}:endpoint:${endpoint}`, 3600);

    // Timeline entry (sliding window for req/min calculation)
    const timelineEntry = JSON.stringify({
      ts: now,
      allowed: allowed ? 1 : 0,
      endpoint,
      identifier: identifier.substring(0, 8), // Truncate for privacy
      node: node || process.env.HOSTNAME || 'node-1',
    });
    pipeline.zadd(TIMELINE_KEY, now, `${now}:${Math.random()}`);
    pipeline.expire(TIMELINE_KEY, 300); // 5 min window

    if (!allowed) {
      pipeline.zadd(BLOCKED_KEY, now, `${now}:${identifier}:${endpoint}`);
      pipeline.expire(BLOCKED_KEY, 300);
    }

    await pipeline.exec();

    // Buffer for local batch reporting
    this.localBuffer.push({ ts: now, allowed, endpoint, remaining });
  }

  async _flush() {
    if (this.localBuffer.length === 0) return;
    this.localBuffer = [];
  }

  async getStats() {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    const pipeline = this.redis.pipeline();
    pipeline.hgetall(METRICS_KEY);
    pipeline.zcount(TIMELINE_KEY, windowStart, now);       // requests in window
    pipeline.zcount(BLOCKED_KEY, windowStart, now);        // blocked in window
    pipeline.zcount(TIMELINE_KEY, now - 1000, now);        // req last second
    pipeline.keys(`${METRICS_KEY}:endpoint:*`);

    const results = await pipeline.exec();

    const globalMetrics = results[0][1] || {};
    const requestsInWindow = results[1][1] || 0;
    const blockedInWindow = results[2][1] || 0;
    const reqLastSecond = results[3][1] || 0;
    const endpointKeys = results[4][1] || [];

    // Fetch per-endpoint stats
    const endpointPipeline = this.redis.pipeline();
    endpointKeys.forEach(k => endpointPipeline.hgetall(k));
    const endpointResults = await endpointPipeline.exec();

    const endpoints = {};
    endpointKeys.forEach((key, i) => {
      const name = key.replace(`${METRICS_KEY}:endpoint:`, '');
      endpoints[name] = endpointResults[i][1] || {};
    });

    return {
      global: {
        totalRequests: parseInt(globalMetrics.total_requests) || 0,
        allowedRequests: parseInt(globalMetrics.allowed_requests) || 0,
        blockedRequests: parseInt(globalMetrics.blocked_requests) || 0,
        lastUpdated: parseInt(globalMetrics.last_updated) || now,
      },
      window: {
        durationMs: this.windowMs,
        requests: requestsInWindow,
        blocked: blockedInWindow,
        requestsPerMinute: Math.round((requestsInWindow / this.windowMs) * 60000),
        requestsPerSecond: reqLastSecond,
        blockRate: requestsInWindow > 0
          ? ((blockedInWindow / requestsInWindow) * 100).toFixed(1)
          : '0.0',
      },
      endpoints,
      timestamp: now,
    };
  }

  async getTimeline(seconds = 30) {
    const now = Date.now();
    const start = now - (seconds * 1000);

    // Get bucketed counts per second
    const buckets = [];
    const pipeline = this.redis.pipeline();

    for (let t = start; t < now; t += 1000) {
      pipeline.zcount(TIMELINE_KEY, t, t + 999);
      pipeline.zcount(BLOCKED_KEY, t, t + 999);
    }

    const results = await pipeline.exec();

    for (let i = 0; i < seconds; i++) {
      const ts = start + (i * 1000);
      buckets.push({
        ts,
        label: new Date(ts).toISOString().substr(17, 5),
        total: results[i * 2]?.[1] || 0,
        blocked: results[i * 2 + 1]?.[1] || 0,
      });
    }

    return buckets;
  }

  destroy() {
    clearInterval(this.flushInterval);
  }
}

module.exports = new MetricsCollector(); // Singleton
