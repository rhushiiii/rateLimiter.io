/**
 * Load Test Script
 * Simulates 100k+ requests/minute against the rate limiter
 * Run: node scripts/loadTest.js [--rps 1000] [--duration 30] [--concurrency 50]
 */

const http = require("http");
const { performance } = require("perf_hooks");

const args = process.argv.slice(2).reduce((acc, val, i, arr) => {
  if (val.startsWith("--")) acc[val.slice(2)] = arr[i + 1];
  return acc;
}, {});

const CONFIG = {
  host: args.host || "localhost",
  port: parseInt(args.port || "3000"),
  path: args.path || "/api/public",
  rps: parseInt(args.rps || "200"),           // requests per second
  duration: parseInt(args.duration || "30"),   // test duration in seconds
  concurrency: parseInt(args.concurrency || "50"),
  ips: parseInt(args.ips || "5"),              // number of simulated IPs
};

const FAKE_IPS = Array.from({ length: CONFIG.ips }, (_, i) => `192.168.1.${i + 1}`);

// Stats tracking
const stats = {
  total: 0,
  allowed: 0,
  limited: 0,
  errors: 0,
  latencies: [],
  startTime: null,
};

function makeRequest(ip) {
  return new Promise((resolve) => {
    const start = performance.now();
    const options = {
      hostname: CONFIG.host,
      port: CONFIG.port,
      path: CONFIG.path,
      method: "GET",
      headers: { "X-Forwarded-For": ip },
    };

    const req = http.request(options, (res) => {
      res.resume();
      const latency = performance.now() - start;
      stats.total++;
      stats.latencies.push(latency);

      if (res.statusCode === 200) stats.allowed++;
      else if (res.statusCode === 429) stats.limited++;
      else stats.errors++;

      resolve({ status: res.statusCode, latency });
    });

    req.on("error", () => {
      stats.errors++;
      resolve({ status: 0, latency: 0 });
    });

    req.setTimeout(5000, () => {
      req.destroy();
      stats.errors++;
      resolve({ status: 0, latency: 0 });
    });

    req.end();
  });
}

async function runBatch(batchSize) {
  const ip = FAKE_IPS[Math.floor(Math.random() * FAKE_IPS.length)];
  const promises = Array.from({ length: batchSize }, () => makeRequest(ip));
  await Promise.all(promises);
}

function printStats(elapsed) {
  const { total, allowed, limited, errors, latencies } = stats;
  const rps = total / elapsed;
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;

  console.clear();
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║       DISTRIBUTED RATE LIMITER - LOAD TEST        ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`  Elapsed:      ${elapsed.toFixed(1)}s / ${CONFIG.duration}s`);
  console.log(`  Target RPS:   ${CONFIG.rps}`);
  console.log(`  Actual RPS:   ${rps.toFixed(0)}`);
  console.log(`  Projected:    ${(rps * 60).toFixed(0)} req/min`);
  console.log("──────────────────────────────────────────────────");
  console.log(`  Total Req:    ${total.toLocaleString()}`);
  console.log(`  ✅ Allowed:   ${allowed.toLocaleString()} (${((allowed/total)*100||0).toFixed(1)}%)`);
  console.log(`  🚫 Limited:   ${limited.toLocaleString()} (${((limited/total)*100||0).toFixed(1)}%)`);
  console.log(`  ❌ Errors:    ${errors.toLocaleString()}`);
  console.log("──────────────────────────────────────────────────");
  console.log(`  Latency p50:  ${p50.toFixed(1)}ms`);
  console.log(`  Latency p95:  ${p95.toFixed(1)}ms`);
  console.log(`  Latency p99:  ${p99.toFixed(1)}ms`);
  console.log("──────────────────────────────────────────────────");
}

async function main() {
  console.log(`Starting load test: ${CONFIG.rps} RPS for ${CONFIG.duration}s`);
  console.log(`Target: ${CONFIG.rps * 60} req/min → 100k+ territory`);
  console.log(`Endpoint: http://${CONFIG.host}:${CONFIG.port}${CONFIG.path}\n`);

  await new Promise((r) => setTimeout(r, 1000));

  stats.startTime = Date.now();
  const intervalMs = 1000 / (CONFIG.rps / CONFIG.concurrency);
  const batchSize = CONFIG.concurrency;
  const endTime = stats.startTime + CONFIG.duration * 1000;

  const interval = setInterval(async () => {
    if (Date.now() >= endTime) {
      clearInterval(interval);
      const elapsed = (Date.now() - stats.startTime) / 1000;
      printStats(elapsed);
      console.log("\n✅ Load test complete!\n");
      process.exit(0);
    }
    const elapsed = (Date.now() - stats.startTime) / 1000;
    if (elapsed > 0 && Math.floor(elapsed) % 2 === 0) {
      printStats(elapsed);
    }
    runBatch(batchSize);
  }, intervalMs);
}

main().catch(console.error);
