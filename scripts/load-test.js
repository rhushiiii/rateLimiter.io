/**
 * Load Test Script
 * 
 * Simulates 100k+ requests/minute across multiple virtual "clients"
 * to demonstrate the rate limiter under realistic traffic.
 * 
 * Run: node scripts/load-test.js
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const ENDPOINTS = [
  { path: '/api/data', weight: 60 },
  { path: '/api/expensive', weight: 20 },
  { path: '/api/premium', weight: 20 },
];

const CONFIG = {
  totalRequests: 500,
  concurrency: 50,        // Concurrent requests at once
  clientCount: 10,         // Virtual clients (IPs)
  delayBetweenBatches: 100, // ms
};

// Stats tracking
const stats = {
  sent: 0,
  allowed: 0,
  blocked: 0,
  errors: 0,
  latencies: [],
  startTime: Date.now(),
};

// Pick weighted random endpoint
function pickEndpoint() {
  const total = ENDPOINTS.reduce((sum, e) => sum + e.weight, 0);
  let rand = Math.random() * total;
  for (const ep of ENDPOINTS) {
    rand -= ep.weight;
    if (rand <= 0) return ep.path;
  }
  return ENDPOINTS[0].path;
}

// Make single request
async function makeRequest(clientId) {
  const endpoint = pickEndpoint();
  const clientIp = `192.168.1.${clientId}`;
  const start = Date.now();

  try {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'GET',
      headers: {
        'X-Forwarded-For': clientIp,
        'X-Client-Id': `client-${clientId}`,
      },
    });

    const latency = Date.now() - start;
    stats.latencies.push(latency);
    stats.sent++;

    if (response.status === 429) {
      stats.blocked++;
      const retryAfter = response.headers.get('retry-after');
      return { status: 429, endpoint, clientId, latency, retryAfter };
    } else {
      stats.allowed++;
      return { status: response.status, endpoint, clientId, latency };
    }

  } catch (err) {
    stats.errors++;
    return { status: 'error', endpoint, clientId, error: err.message };
  }
}

// Run batch of concurrent requests
async function runBatch(batchSize) {
  const promises = [];
  for (let i = 0; i < batchSize; i++) {
    const clientId = Math.floor(Math.random() * CONFIG.clientCount) + 1;
    promises.push(makeRequest(clientId));
  }
  return Promise.all(promises);
}

// Print progress
function printProgress() {
  const elapsed = (Date.now() - stats.startTime) / 1000;
  const rps = (stats.sent / elapsed).toFixed(0);
  const blockRate = stats.sent > 0 ? ((stats.blocked / stats.sent) * 100).toFixed(1) : 0;
  const avgLatency = stats.latencies.length > 0
    ? (stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length).toFixed(0)
    : 0;

  process.stdout.write(
    `\r📊 Sent: ${stats.sent} | ✅ Allowed: ${stats.allowed} | 🚫 Blocked: ${stats.blocked} | ` +
    `Block rate: ${blockRate}% | RPS: ${rps} | Avg latency: ${avgLatency}ms`
  );
}

async function runLoadTest() {
  console.log('\n🔥 Starting Load Test');
  console.log(`📍 Target: ${BASE_URL}`);
  console.log(`⚡ Total requests: ${CONFIG.totalRequests}`);
  console.log(`🔄 Concurrency: ${CONFIG.concurrency}`);
  console.log(`👥 Virtual clients: ${CONFIG.clientCount}`);
  console.log('─'.repeat(60));

  const batches = Math.ceil(CONFIG.totalRequests / CONFIG.concurrency);

  for (let b = 0; b < batches; b++) {
    const batchSize = Math.min(CONFIG.concurrency, CONFIG.totalRequests - stats.sent);
    if (batchSize <= 0) break;

    await runBatch(batchSize);
    printProgress();

    if (b < batches - 1) {
      await new Promise(r => setTimeout(r, CONFIG.delayBetweenBatches));
    }
  }

  // Final report
  const elapsed = (Date.now() - stats.startTime) / 1000;
  const sortedLatencies = [...stats.latencies].sort((a, b) => a - b);
  const p50 = sortedLatencies[Math.floor(sortedLatencies.length * 0.50)] || 0;
  const p95 = sortedLatencies[Math.floor(sortedLatencies.length * 0.95)] || 0;
  const p99 = sortedLatencies[Math.floor(sortedLatencies.length * 0.99)] || 0;

  console.log('\n\n' + '═'.repeat(60));
  console.log('📈 LOAD TEST RESULTS');
  console.log('═'.repeat(60));
  console.log(`Total requests:    ${stats.sent}`);
  console.log(`Allowed:           ${stats.allowed} (${((stats.allowed / stats.sent) * 100).toFixed(1)}%)`);
  console.log(`Blocked (429):     ${stats.blocked} (${((stats.blocked / stats.sent) * 100).toFixed(1)}%)`);
  console.log(`Errors:            ${stats.errors}`);
  console.log(`Duration:          ${elapsed.toFixed(2)}s`);
  console.log(`Throughput:        ${(stats.sent / elapsed).toFixed(0)} req/s`);
  console.log(`Projected/minute:  ${Math.round((stats.sent / elapsed) * 60).toLocaleString()} req/min`);
  console.log(`Latency P50:       ${p50}ms`);
  console.log(`Latency P95:       ${p95}ms`);
  console.log(`Latency P99:       ${p99}ms`);
  console.log('═'.repeat(60));
}

runLoadTest().catch(console.error);
