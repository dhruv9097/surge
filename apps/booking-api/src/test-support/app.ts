import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createHttpApp, loadConfig } from '@surge/common';
import { AppModule } from '../app.module.js';
import { configSchema } from '../config.js';
import type { TestInfra } from './infra.js';

export async function createTestApp(
  infra: TestInfra,
  env: Record<string, string> = {},
): Promise<NestFastifyApplication> {
  const config = loadConfig(configSchema, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    DATABASE_URL: infra.databaseUrl,
    REDIS_URL: infra.redisUrl,
    ...env,
  });
  const app = await createHttpApp(AppModule.forRoot(config));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

/** A buyer with their own identity, talking to the API in-process. */
export function buyer(app: NestFastifyApplication, userId: string = randomUUID()) {
  const headers = { 'x-user-id': userId };
  return {
    userId,
    hold: (eventId: string, seatIds: string[]) =>
      app.inject({
        method: 'POST',
        url: `/events/${eventId}/holds`,
        headers,
        payload: { seatIds },
      }),
    release: (eventId: string, holdId: string) =>
      app.inject({ method: 'DELETE', url: `/events/${eventId}/holds/${holdId}`, headers }),
    checkout: (eventId: string, holdId: string, idempotencyKey: string = randomUUID()) =>
      app.inject({
        method: 'POST',
        url: `/events/${eventId}/holds/${holdId}/checkout`,
        headers: { ...headers, 'idempotency-key': idempotencyKey },
      }),
    order: (orderId: string) => app.inject({ method: 'GET', url: `/orders/${orderId}`, headers }),
  };
}
