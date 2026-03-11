# Distributed Rate Limiter

Distributed rate limiter service using Node.js + Redis with policy-driven enforcement.

Supports:
- Scopes: ip, user, apiKey, endpoint, organization
- Algorithms: fixed_window, sliding_window, token_bucket, leaky_bucket
- Shared state across instances through Redis
- Runtime policy configuration via API
- Metrics in JSON and Prometheus formats

## Architecture

```text
Client
  -> API Gateway / Edge Proxy
  -> Express Rate Limiter Middleware
  -> Policy Engine
  -> Redis (atomic Lua scripts + TTL)
  -> Backend handlers
```

Blocked traffic returns `429 Too Many Requests` with rate limit headers.

## Implemented Requirements Mapping

1. Distributed enforcement: all decisions use Redis keys shared by all nodes.
2. Multiple algorithms: four algorithms available per policy.
3. Configurable policies: create/update/delete via `/api/policies`.
4. Multi-scope limiting: per scope identity extraction is built-in.
5. Observability: `/api/metrics` and `/metrics` expose request, reject, active client, and latency metrics.
6. Reliability mode: `FAIL_STRATEGY=fail_open|fail_closed` controls behavior when Redis is unavailable.

## Policy Model

```json
{
  "id": "public-ip-fixed",
  "name": "Public IP fixed window",
  "algorithm": "fixed_window",
  "scope": "ip",
  "method": "GET",
  "endpointPattern": "/api/public",
  "limit": 100,
  "windowSec": 60,
  "capacity": 100,
  "refillRate": 1.66,
  "cost": 1,
  "enabled": true
}
```

Notes:
- `capacity/refillRate` are primarily used by token/leaky bucket.
- `endpointPattern` supports exact match and prefix wildcard (`/api/*`).

## API Endpoints

1. `GET /api/status` health + redis state
2. `GET /api/public` sample protected endpoint
3. `POST /api/strict` sample protected endpoint
4. `GET /api/premium` sample protected endpoint
5. `GET /api/policies` list active policies
6. `POST /api/policies` create policy
7. `PUT /api/policies/:id` update policy
8. `DELETE /api/policies/:id` delete policy
9. `GET /api/metrics` JSON metrics
10. `GET /metrics` Prometheus metrics
11. `GET /api/stats` redis key snapshot

## Response Headers

Protected endpoints include:
- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Policy`
- `X-RateLimit-Reset`
- `X-RateLimit-Latency-Ms`
- `Retry-After` on blocked requests

## Local Run

```bash
npm install
cp .env.example .env
npm start
```

## Load Testing

```bash
npm run load-test
npm run benchmark
```

`benchmark` uses higher request volume to validate throughput and rejection behavior.

## Docker / Kubernetes

Existing deployment files under `docker-compose.yml` and `k8s/` remain usable for horizontal scaling.

## Testing

```bash
npm test
```

Current tests validate policy matching behavior. Add algorithm-level and integration tests for production hardening.
