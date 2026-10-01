import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { createHttpApp, LifecycleService, loadConfig } from '@surge/common';
import { AppModule } from './app.module.js';
import { configSchema } from './config.js';

describe('booking-api (integration)', () => {
  let pg: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    [pg, redis] = await Promise.all([
      new PostgreSqlContainer('postgres:18.6-trixie').start(),
      new RedisContainer('redis:8.6.7-alpine').start(),
    ]);
    const config = loadConfig(configSchema, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      DATABASE_URL: pg.getConnectionUri(),
      REDIS_URL: redis.getConnectionUrl(),
    });
    app = await createHttpApp(AppModule.forRoot(config));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([pg?.stop(), redis?.stop()]);
  });

  it('liveness does not depend on downstream services', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
  });

  it('readiness reports database and redis as up', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ok',
      info: { database: { status: 'up' }, redis: { status: 'up' } },
    });
  });

  it('exposes Prometheus metrics including pool and HTTP series', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('db_pool_requests_waiting');
    expect(res.body).toContain('http_request_duration_seconds');
    expect(res.body).toContain('nodejs_eventloop_lag');
  });

  it('returns the uniform error shape for unknown routes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/nope',
      headers: { 'x-request-id': 'req-123' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Cannot GET /nope', requestId: 'req-123' },
    });
  });

  it('generates a uuid request id when none is supplied', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    const body = res.json<{ error: { requestId: string } }>();
    expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  // Runs last: draining is one-way for the life of the app.
  it('fails readiness while draining so the load balancer stops routing', async () => {
    app.get(LifecycleService).startDraining();
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
  });
});
