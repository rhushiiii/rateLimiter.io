const Redis = require('ioredis');

let client = null;

function createRedisClient() {
  const config = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    db: parseInt(process.env.REDIS_DB) || 0,
    retryStrategy: (times) => {
      if (times > 10) return null; // Stop retrying
      return Math.min(times * 100, 3000); // Exponential backoff
    },
    lazyConnect: true,
    enableReadyCheck: true,
  };

  if (process.env.REDIS_PASSWORD) {
    config.password = process.env.REDIS_PASSWORD;
  }

  const redis = new Redis(config);

  redis.on('connect', () => console.log('[Redis] Connected'));
  redis.on('ready', () => console.log('[Redis] Ready'));
  redis.on('error', (err) => console.error('[Redis] Error:', err.message));
  redis.on('close', () => console.warn('[Redis] Connection closed'));
  redis.on('reconnecting', () => console.log('[Redis] Reconnecting...'));

  return redis;
}

function getClient() {
  if (!client) {
    client = createRedisClient();
  }
  return client;
}

async function connect() {
  const redis = getClient();
  await redis.connect();
  return redis;
}

async function disconnect() {
  if (client) {
    await client.quit();
    client = null;
  }
}

module.exports = { getClient, connect, disconnect };
