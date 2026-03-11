const express = require("express");
const { createRateLimiter, strictLimiter, apiKeyLimiter } = require("../middleware/rateLimiter");
const { TokenBucket } = require("../algorithms/tokenBucket");
const { getRedisClient } = require("../redis/client");

const router = express.Router();

// ── /api/status ─────────────────────────────────────────────────────────────
// Health check - no rate limit
router.get("/status", async (req, res) => {
  const redis = getRedisClient();
  let redisStatus = "disconnected";
  try {
    await redis.ping();
    redisStatus = "connected";
  } catch {}

  res.json({
    status: "ok",
    redis: redisStatus,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// ── /api/public ──────────────────────────────────────────────────────────────
// Standard public endpoint: 100 req/min
router.get(
  "/public",
  createRateLimiter({ capacity: 100, refillRate: 100 / 60, keyPrefix: "public" }),
  (req, res) => {
    res.json({ message: "Public endpoint response", ts: Date.now() });
  }
);

// ── /api/strict ──────────────────────────────────────────────────────────────
// Strict endpoint: 5 req/min (simulates a login or sensitive endpoint)
router.post(
  "/strict",
  createRateLimiter({ capacity: 5, refillRate: 5 / 60, keyPrefix: "login" }),
  (req, res) => {
    res.json({ message: "Authenticated! (strict endpoint)", ts: Date.now() });
  }
);

// ── /api/premium ─────────────────────────────────────────────────────────────
// Per-API-key rate limit: 500 req/min
router.get("/premium", apiKeyLimiter, (req, res) => {
  const key = req.headers["x-api-key"] || "anonymous";
  res.json({ message: `Premium response for key: ${key}`, ts: Date.now() });
});

// ── /api/bucket/:key ─────────────────────────────────────────────────────────
// Inspect a bucket's current state (for debugging / demo)
router.get("/bucket/:key", async (req, res) => {
  const bucket = new TokenBucket({ capacity: 100, refillRate: 100 / 60 });
  const state = await bucket.peek(req.params.key);
  res.json({ key: req.params.key, ...state });
});

// ── /api/reset/:key ──────────────────────────────────────────────────────────
// Reset a specific bucket (admin use)
router.delete("/reset/:key", async (req, res) => {
  const redis = getRedisClient();
  const deleted = await redis.del(`rl:bucket:${req.params.key}`);
  res.json({ key: req.params.key, reset: deleted > 0 });
});

// ── /api/stats ───────────────────────────────────────────────────────────────
// Show all active rate-limit buckets
router.get("/stats", async (req, res) => {
  const redis = getRedisClient();
  const keys = await redis.keys("rl:bucket:*");
  const stats = [];
  for (const k of keys.slice(0, 50)) { // cap at 50 for safety
    const data = await redis.hgetall(k);
    stats.push({ key: k.replace("rl:bucket:", ""), ...data });
  }
  res.json({ total: keys.length, buckets: stats });
});

module.exports = router;
