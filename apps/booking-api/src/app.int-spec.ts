import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { LifecycleService } from '@surge/common';
import { createTestApp } from './test-support/app.js';
import { startInfra, type TestInfra } from '@surge/testing';

describe('booking-api platform (integration)', () => {
  let infra: TestInfra;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    infra = await startInfra();
    app = await createTestApp(infra);
  });

  afterAll(async () => {
    await app?.close();
    await infra?.stop();
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
