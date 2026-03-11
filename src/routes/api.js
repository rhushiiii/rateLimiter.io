const express = require("express");
const { distributedRateLimiter, policyStore, metricsService } = require("../middleware/rateLimiter");
const { normalizePolicy } = require("../services/policyStore");
const { getRedisClient } = require("../redis/client");

const router = express.Router();
const limiter = distributedRateLimiter();

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
    failStrategy: process.env.FAIL_STRATEGY || "fail_open",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

router.get("/public", limiter, (req, res) => {
  res.json({ message: "Public endpoint response", ts: Date.now() });
});

router.post("/strict", limiter, (req, res) => {
  res.json({ message: "Authenticated! (strict endpoint)", ts: Date.now() });
});

router.get("/premium", limiter, (req, res) => {
  const key = req.headers["x-api-key"] || "anonymous";
  res.json({ message: `Premium response for key: ${key}`, ts: Date.now() });
});

router.get("/policies", async (req, res) => {
  const policies = await policyStore.list();
  res.json({ total: policies.length, policies });
});

router.post("/policies", async (req, res) => {
  const policy = normalizePolicy(req.body || {});
  const created = await policyStore.create(policy);
  res.status(201).json(created);
});

router.put("/policies/:id", async (req, res) => {
  const updated = await policyStore.update(req.params.id, req.body || {});
  if (!updated) {
    return res.status(404).json({ error: "Policy not found" });
  }
  return res.json(updated);
});

router.delete("/policies/:id", async (req, res) => {
  const removed = await policyStore.remove(req.params.id);
  if (!removed) {
    return res.status(404).json({ error: "Policy not found" });
  }
  return res.status(204).send();
});

router.get("/metrics", async (req, res) => {
  const snapshot = await metricsService.snapshot();
  res.json(snapshot);
});

router.get("/stats", async (req, res) => {
  const redis = getRedisClient();
  const keys = await redis.keys("rl:*");
  res.json({ totalKeys: keys.length, sample: keys.slice(0, 50) });
});

module.exports = router;
