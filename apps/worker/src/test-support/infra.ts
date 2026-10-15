import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedpandaContainer, type StartedRedpandaContainer } from '@testcontainers/redpanda';
import { createHttpApp, loadConfig, type OrderCreatedEvent, Topics } from '@surge/common';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { AppModule } from '../app.module.js';
import { configSchema } from '../config.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

export interface WorkerInfra {
  pg: StartedPostgreSqlContainer;
  redpanda: StartedRedpandaContainer;
  databaseUrl: string;
  brokers: string;
  db: pg.Pool;
  stop(): Promise<void>;
}

export async function startInfra(): Promise<WorkerInfra> {
  const [pgContainer, redpanda] = await Promise.all([
    new PostgreSqlContainer('postgres:18.6-trixie').start(),
    new RedpandaContainer('redpandadata/redpanda:v26.2.3').start(),
  ]);
  const databaseUrl = pgContainer.getConnectionUri();
  await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
  const db = new pg.Pool({ connectionString: databaseUrl });
  return {
    pg: pgContainer,
    redpanda,
    databaseUrl,
    brokers: redpanda.getBootstrapServers(),
    db,
    stop: async () => {
      await db.end();
      await Promise.all([pgContainer.stop(), redpanda.stop()]);
    },
  };
}

export async function createWorkerApp(
  infra: WorkerInfra,
  env: Record<string, string> = {},
): Promise<NestFastifyApplication> {
  const config = loadConfig(configSchema, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    DATABASE_URL: infra.databaseUrl,
    KAFKA_BROKERS: infra.brokers,
    OUTBOX_IDLE_POLL_MS: '50',
    ...env,
  });
  const app = await createHttpApp(AppModule.forRoot(config));
  await app.init();
  return app;
}

/**
 * Writes a pending order and its order.created outbox row exactly as the
 * booking API's checkout transaction does.
 */
export async function insertPendingOrder(
  db: pg.Pool,
  outboxCopies = 1,
): Promise<OrderCreatedEvent> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO events (name, venue, starts_at, sale_opens_at)
     VALUES ('Worker Test', 'Arena', now() + interval '1 day', now()) RETURNING id`,
  );
  const eventId = rows[0]!.id;
  await db.query(
    `INSERT INTO seats (event_id, seat_id, section, price_cents) VALUES ($1, 'S-1', 'FLOOR', 5000)`,
    [eventId],
  );
  const holdId = randomUUID();
  const userId = randomUUID();
  const order = await db.query<{ id: string; created_at: Date }>(
    `INSERT INTO orders (event_id, user_id, hold_id, idempotency_key, seat_ids, total_cents)
     VALUES ($1, $2, $3, $4, '{S-1}', 5000) RETURNING id, created_at`,
    [eventId, userId, holdId, `key-${holdId}`],
  );
  const event: OrderCreatedEvent = {
    type: 'order.created',
    orderId: order.rows[0]!.id,
    eventId,
    userId,
    holdId,
    seatIds: ['S-1'],
    totalCents: 5000,
    createdAt: order.rows[0]!.created_at.toISOString(),
  };
  for (let i = 0; i < outboxCopies; i++) {
    await db.query('INSERT INTO outbox (topic, key, payload) VALUES ($1, $2, $3)', [
      Topics.ORDERS,
      event.orderId,
      JSON.stringify(event),
    ]);
  }
  return event;
}

export async function waitFor<T>(
  check: () => Promise<T | undefined | null | false>,
  { timeoutMs = 30_000, intervalMs = 100 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`Condition not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
