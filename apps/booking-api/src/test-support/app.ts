import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AdmissionTokens, createHttpApp, loadConfig } from '@surge/common';
import { AppModule } from '../app.module.js';
import { configSchema } from '../config.js';
import type { TestInfra } from '@surge/testing';

export const TEST_ADMISSION_SECRET = 'test-admission-secret-of-at-least-32-chars';
export const testTokens = new AdmissionTokens(TEST_ADMISSION_SECRET);

export async function createTestApp(
  infra: TestInfra,
  env: Record<string, string> = {},
): Promise<NestFastifyApplication> {
  const config = loadConfig(configSchema, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    DATABASE_URL: infra.databaseUrl,
    REDIS_URL: infra.redisUrl,
    ADMISSION_TOKEN_SECRET: TEST_ADMISSION_SECRET,
    ...env,
  });
  const app = await createHttpApp(AppModule.forRoot(config));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

/**
 * A buyer the waiting room has admitted, talking to the API in-process.
 * Each request carries a fresh admission token for the event it targets.
 */
export function buyer(app: NestFastifyApplication, userId: string = randomUUID()) {
  const auth = async (eventId: string) => ({
    authorization: `Bearer ${(await testTokens.sign({ userId, eventId }, 600)).token}`,
  });
  return {
    userId,
    hold: async (eventId: string, seatIds: string[]) =>
      app.inject({
        method: 'POST',
        url: `/events/${eventId}/holds`,
        headers: await auth(eventId),
        payload: { seatIds },
      }),
    release: async (eventId: string, holdId: string) =>
      app.inject({
        method: 'DELETE',
        url: `/events/${eventId}/holds/${holdId}`,
        headers: await auth(eventId),
      }),
    checkout: async (eventId: string, holdId: string, idempotencyKey: string = randomUUID()) =>
      app.inject({
        method: 'POST',
        url: `/events/${eventId}/holds/${holdId}/checkout`,
        headers: { ...(await auth(eventId)), 'idempotency-key': idempotencyKey },
      }),
    order: async (orderId: string, eventId: string) =>
      app.inject({ method: 'GET', url: `/orders/${orderId}`, headers: await auth(eventId) }),
  };
}
