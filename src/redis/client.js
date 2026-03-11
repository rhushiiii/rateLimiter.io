const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

let client = null;

function getRedisClient() {
  if (client) return client;

  client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > 5) return null; // Stop retrying after 5 attempts
      return Math.min(times * 200, 2000); // Exponential backoff
    },
    lazyConnect: false,
  });

  client.on("connect", () => {
    console.log(`[Redis] Connected to ${REDIS_URL}`);
  });

  client.on("error", (err) => {
    console.error("[Redis] Connection error:", err.message);
  });

  client.on("reconnecting", () => {
    console.warn("[Redis] Reconnecting...");
  });

  return client;
}

module.exports = { getRedisClient };
