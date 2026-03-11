# Distributed Rate Limiter

A production-grade distributed API rate-limiting service using **Node.js**, **Redis**, **Docker**, and **Kubernetes**.  
Implements the **Token Bucket algorithm** with atomic Lua scripts for distributed correctness.

---

## Architecture

```
Client Requests
      │
      ▼
┌─────────────────┐     ┌─────────────────────────────────────┐
│  Express App    │────▶│  Rate Limiter Middleware             │
│  (Node.js)      │     │  - Extract key (IP / API key)       │
│                 │     │  - Call TokenBucket.consume()        │
│  Multiple pods  │     │  - Set X-RateLimit-* headers        │
│  all share same │     └─────────────┬───────────────────────┘
│  Redis instance │                   │
└─────────────────┘     ┌─────────────▼───────────────────────┐
                        │  Redis (Shared State)               │
                        │  - Lua script runs atomically       │
                        │  - Token buckets: HSET rl:bucket:*  │
                        │  - No race conditions across pods   │
                        └─────────────────────────────────────┘
```

## Token Bucket Algorithm

Each bucket stores `tokens` and `last_refill` in Redis.

On every request:
1. Calculate elapsed time since last refill
2. Add `elapsed_seconds × refillRate` tokens (capped at capacity)
3. If `tokens >= cost` → **allow**, deduct tokens
4. If `tokens < cost` → **deny** with 429 + `Retry-After` header

The entire check-and-consume runs as a **single atomic Lua script** in Redis.  
This is the critical design choice: no race conditions even across 10+ app instances.

---

## Quick Start

### Local (requires Redis running)

```bash
# Install dependencies
npm install

# Copy env config
cp .env.example .env

# Start Redis (Docker one-liner)
docker run -d -p 6379:6379 redis:7-alpine

# Start server
npm start

# Open dashboard
open http://localhost:3000
```

### Docker Compose (recommended)

```bash
# Single instance
npm run docker:up

# Scaled: 3 app instances + Nginx load balancer
docker-compose --profile scaled up --build
# App available at http://localhost:8080
```

### Kubernetes

```bash
# Build image
docker build -t rate-limiter:latest .

# Deploy Redis
kubectl apply -f k8s/redis-deployment.yaml

# Deploy app (3 replicas) + LoadBalancer + HPA
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml

# Check pods
kubectl get pods
kubectl get hpa

# Scale manually
kubectl scale deployment rate-limiter --replicas=5
```

---

## API Endpoints

| Method | Endpoint | Rate Limit | Description |
|--------|----------|------------|-------------|
| GET | `/api/status` | None | Health check + Redis status |
| GET | `/api/public` | 100 req/min per IP | Standard public endpoint |
| POST | `/api/strict` | 5 req/min per IP | Simulates login/sensitive endpoint |
| GET | `/api/premium` | 500 req/min per API key | Per-key limit via `X-Api-Key` header |
| GET | `/api/bucket/:key` | None | Inspect a bucket's token state |
| DELETE | `/api/reset/:key` | None | Reset/clear a bucket |
| GET | `/api/stats` | None | List all active buckets |

### Rate Limit Headers

Every response includes:
```
X-RateLimit-Limit:     100          # Bucket capacity
X-RateLimit-Remaining: 84           # Tokens left
X-RateLimit-Policy:    100;w=60     # Limit and window
Retry-After:           3            # Seconds to wait (on 429 only)
X-RateLimit-Reset:     <ISO date>   # When bucket refills (on 429 only)
```

---

## Load Test

```bash
# Run load test (default: 200 RPS for 30s)
npm run load-test

# Custom: 1000 RPS for 60 seconds across 5 simulated IPs
node scripts/loadTest.js --rps 1000 --duration 60 --ips 5

# At 1667 RPS → 100,040 req/min
node scripts/loadTest.js --rps 1667 --duration 30
```

Sample output:
```
╔══════════════════════════════════════════════════╗
║       DISTRIBUTED RATE LIMITER - LOAD TEST        ║
╚══════════════════════════════════════════════════╝
  Elapsed:      15.0s / 30s
  Target RPS:   1667
  Actual RPS:   1643
  Projected:    98,580 req/min
──────────────────────────────────────────────────
  Total Req:    24,645
  ✅ Allowed:   1,500 (6.1%)
  🚫 Limited:   23,100 (93.7%)
  ❌ Errors:    45
──────────────────────────────────────────────────
  Latency p50:  2.1ms
  Latency p95:  8.4ms
  Latency p99:  15.2ms
```

---

## Custom Middleware Usage

```javascript
const { createRateLimiter } = require('./src/middleware/rateLimiter');

// Per-IP: 200 requests/minute
app.use('/api', createRateLimiter({
  capacity:   200,
  refillRate: 200 / 60,  // tokens per second
  keyPrefix:  'myapp',
}));

// Per-user from JWT
app.use('/api/data', createRateLimiter({
  capacity:   1000,
  refillRate: 1000 / 60,
  keyGenerator: (req) => req.user?.id || req.ip,
}));

// Per-endpoint (different limits for different routes)
app.post('/auth/login', createRateLimiter({ capacity: 5, refillRate: 5/60 }), loginHandler);
app.get('/feed',        createRateLimiter({ capacity: 300, refillRate: 5 }), feedHandler);
```

---

## Project Structure

```
distributed-rate-limiter/
├── src/
│   ├── server.js                  # Express app entry point
│   ├── algorithms/
│   │   └── tokenBucket.js         # Token bucket + Lua script
│   ├── middleware/
│   │   └── rateLimiter.js         # Express middleware factory
│   ├── redis/
│   │   └── client.js              # Redis connection + retry logic
│   └── routes/
│       └── api.js                 # API route definitions
├── public/
│   └── index.html                 # Live dashboard UI
├── scripts/
│   └── loadTest.js                # Load testing tool
├── k8s/
│   ├── redis-deployment.yaml      # Redis pod + headless service
│   ├── deployment.yaml            # App deployment + HPA
│   └── service.yaml               # LoadBalancer service
├── config/
│   └── nginx.conf                 # Nginx load balancer config
├── Dockerfile                     # Multi-stage production build
├── docker-compose.yml             # Single + scaled profiles
└── .env.example
```

---

## Design Decisions

**Why Lua scripts?**  
Redis executes Lua scripts atomically — the read-modify-write of the token bucket is a single operation. Without this, concurrent requests across instances could read the same token count and both succeed when only one should.

**Why token bucket over fixed window?**  
Fixed window allows 2× the rate at window boundaries (burst). Token bucket smooths traffic and allows controlled bursts up to `capacity`, which is more realistic for API protection.

**Why fail open on Redis failure?**  
Availability > strict rate limiting. If Redis is unreachable, the service allows requests through rather than blocking all traffic. In production you'd add a circuit breaker and fallback local rate limiter.

**Why `X-Forwarded-For` for IP extraction?**  
Behind a load balancer, all requests come from the same internal IP. Reading `X-Forwarded-For` correctly identifies the original client across proxies.
