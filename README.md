# Surge

A flash-sale ticket booking backend built to survive the moment 20,000 people try to buy 1,000 seats at once — without overselling a single seat, without falling over, and with alerts that fire before users notice anything is wrong.

> **Status: under active development.** The production foundation is done; booking, spike defense, observability and the load/chaos results land milestone by milestone (see [Roadmap](#roadmap)). Benchmark numbers will be published here only once they are measured.

## Architecture

```
Client ─► Nginx (LB, timeouts, conn limits)
            ├─► waiting-room ×N   virtual queue, admission tokens
            └─► booking-api  ×N   inventory, seat holds, checkout
                     │ outbox            │
                     ▼                   ├─► Redis      holds, queue, rate limits, idempotency
                 Redpanda (Kafka) ─► worker ×N         └─► PgBouncer ─► PostgreSQL (source of truth)
                                        └─► payment (circuit-broken)

Observability: OpenTelemetry → Tempo · Prometheus + Alertmanager · Loki · Grafana
```

## Stack

TypeScript · NestJS 12 (Fastify) · PostgreSQL 18 · PgBouncer · Redis 8 · Redpanda (Kafka API) · Nginx · Docker Compose · Prometheus · OpenTelemetry · Vitest + Testcontainers · GitHub Actions

## Production practices already in place

- **Fail-fast config** — every env var is validated with zod at startup; a bad deploy dies immediately with a readable error.
- **Zero-downtime shutdown** — on SIGTERM the instance fails readiness, waits for the load balancer to stop routing, drains in-flight requests, then closes pools, all under a hard timeout.
- **Health probes that can't become load** — liveness has no dependencies; readiness checks Postgres/Redis with timeouts and a short result cache.
- **Early-warning metrics** — per-route latency histograms, in-flight requests, event-loop lag and DB pool wait counts (which rise before latency or errors do).
- **Safe database defaults** — PgBouncer transaction pooling; server-side `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout` for the app role.
- **Fail-fast Redis** — no offline queue (commands fail instead of piling up during an outage), command timeouts, `noeviction` so seat holds are never silently dropped.
- **Uniform errors** — one JSON error shape with a request id; internals never leak to clients.
- **Hardened images and supply chain** — multi-stage, non-root runtime images; dependency install scripts denied by default; freshly published package versions blocked by release-age policy.

## Running locally

Requires Node 24+, pnpm, and Docker (sized for a laptop with 8 GB RAM; give Docker ~5 GB).

```bash
pnpm install
cp .env.example .env
docker compose up -d --build        # API on http://localhost:8080
```

```bash
pnpm lint && pnpm typecheck         # static checks
pnpm test                           # unit tests
pnpm test:integration               # real Postgres + Redis via Testcontainers
```

## Roadmap

| #   | Milestone                                                                                               | Status |
| --- | ------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Foundation: config, logging, metrics, tracing, health, graceful shutdown, Docker, CI                    | ✅     |
| 2   | Core booking: seat holds (Redis Lua), DB-enforced uniqueness, idempotent checkout, transactional outbox | ⏳     |
| 3   | Spike defense: waiting room, rate limiting, adaptive load shedding, circuit breakers                    | ⏳     |
| 4   | Observability: Grafana dashboards, SLO burn-rate alerts, synthetic checkout probe, runbooks             | ⏳     |
| 5   | Proof: k6 spike/soak tests, chaos experiments, oversell audit, published results                        | ⏳     |
| 6   | Deploy: free-tier cloud VM, TLS, CI/CD rolling deploys, backups                                         | ⏳     |
