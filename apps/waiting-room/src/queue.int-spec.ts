import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AdmissionTokens, createHttpApp, loadConfig } from '@surge/common';
import { seedEvent, startInfra, type TestInfra } from '@surge/testing';
import { AppModule } from './app.module.js';
import { configSchema } from './config.js';
import type { QueueStatus } from './queue/queue.service.js';

const SECRET = 'test-admission-secret-of-at-least-32-chars';
type Json = Record<string, unknown>;

describe('waiting room (integration)', () => {
  let infra: TestInfra;
  let app: NestFastifyApplication;

  const RATE = 10;

  beforeAll(async () => {
    infra = await startInfra();
    const config = loadConfig(configSchema, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      DATABASE_URL: infra.databaseUrl,
      REDIS_URL: infra.redisUrl,
      ADMISSION_TOKEN_SECRET: SECRET,
      ADMIT_RATE_PER_SECOND: String(RATE),
    });
    app = await createHttpApp(AppModule.forRoot(config));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
    await infra?.stop();
  });

  const join = (eventId: string, userId: string) =>
    app.inject({
      method: 'POST',
      url: `/events/${eventId}/queue`,
      headers: { 'x-user-id': userId },
    });
  const poll = (eventId: string, userId: string) =>
    app.inject({
      method: 'GET',
      url: `/events/${eventId}/queue`,
      headers: { 'x-user-id': userId },
    });

  it('admits a buyer straight away when nobody is queueing', async () => {
    const { eventId } = await seedEvent(infra.databaseUrl, 10);
    const userId = randomUUID();
    const res = await join(eventId, userId);
    expect(res.statusCode).toBe(201);
    const body = res.json<QueueStatus>();
    expect(body.status).toBe('admitted');

    // The token is exactly what the booking API will verify.
    const verified = await new AdmissionTokens(SECRET).verify(
      (body as Extract<QueueStatus, { status: 'admitted' }>).token,
    );
    expect(verified).toEqual({ ok: true, admission: { userId, eventId } });
  });

  it('lets a burst through at the configured rate, first come first served', async () => {
    const { eventId } = await seedEvent(infra.databaseUrl, 10);
    const users = Array.from({ length: 100 }, () => randomUUID());

    // Join in order so sequence numbers are deterministic.
    for (const u of users) await join(eventId, u);

    const statuses = async () =>
      Promise.all(users.map(async (u) => (await poll(eventId, u)).json<QueueStatus>()));

    const before = await statuses();
    const admittedBefore = before.filter((s) => s.status === 'admitted').length;
    expect(admittedBefore).toBeLessThan(10);

    await new Promise((r) => setTimeout(r, 1_000));
    const after = await statuses();
    const admittedAfter = after.filter((s) => s.status === 'admitted').length;

    // ~RATE more per second, with slack for timing jitter.
    expect(admittedAfter - admittedBefore).toBeGreaterThanOrEqual(RATE - 3);
    expect(admittedAfter - admittedBefore).toBeLessThanOrEqual(RATE + 5);

    // FIFO: exactly the earliest joiners are admitted.
    const admittedIdx = after.flatMap((s, i) => (s.status === 'admitted' ? [i] : []));
    expect(admittedIdx).toEqual(admittedIdx.map((_, i) => i));

    // Everyone still waiting sees a distinct position, counting up from 1.
    const positions = after.flatMap((s) => (s.status === 'waiting' ? [s.position] : []));
    expect(positions).toEqual(positions.map((_, i) => i + 1));
  });

  it('keeps a buyer in the same place if they join again', async () => {
    const { eventId } = await seedEvent(infra.databaseUrl, 10, { saleOpensInMs: 3_600_000 });
    const a = randomUUID();
    const b = randomUUID();
    await join(eventId, a);
    await join(eventId, b);
    const again = (await join(eventId, a)).json<Json>();
    expect(again).toMatchObject({ status: 'waiting', position: 1 });
    expect((await poll(eventId, b)).json()).toMatchObject({ status: 'waiting', position: 2 });
  });

  it('holds everyone until the sale opens and says when that is', async () => {
    const { eventId } = await seedEvent(infra.databaseUrl, 10, { saleOpensInMs: 3_600_000 });
    const res = (await join(eventId, randomUUID())).json<
      Extract<QueueStatus, { status: 'waiting' }>
    >();
    expect(res.status).toBe('waiting');
    expect(Date.parse(res.saleOpensAt)).toBeGreaterThan(Date.now());
    expect(res.estimatedWaitSeconds).toBeGreaterThan(3_500);
    expect(res.pollAfterMs).toBe(30_000);
  });

  it('rejects unknown events, missing users and non-members', async () => {
    const { eventId } = await seedEvent(infra.databaseUrl, 10);
    const code = (r: { json: () => unknown }) => (r.json() as { error: Json }).error.code;
    expect(code(await join(randomUUID(), randomUUID()))).toBe('EVENT_NOT_FOUND');
    expect(code(await poll(eventId, randomUUID()))).toBe('NOT_IN_QUEUE');
    const anon = await app.inject({ method: 'POST', url: `/events/${eventId}/queue` });
    expect(code(anon)).toBe('UNAUTHENTICATED');
  });
});
