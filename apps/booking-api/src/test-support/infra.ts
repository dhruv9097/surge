import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { runner } from 'node-pg-migrate';
import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

export interface TestInfra {
  pg: StartedPostgreSqlContainer;
  redis: StartedRedisContainer;
  databaseUrl: string;
  redisUrl: string;
  stop(): Promise<void>;
}

/** Real Postgres and Redis with the production migrations applied. */
export async function startInfra(): Promise<TestInfra> {
  const [pgContainer, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:18.6-trixie').start(),
    new RedisContainer('redis:8.6.7-alpine').start(),
  ]);
  const databaseUrl = pgContainer.getConnectionUri();
  await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
  return {
    pg: pgContainer,
    redis,
    databaseUrl,
    redisUrl: redis.getConnectionUrl(),
    stop: async () => {
      await Promise.all([pgContainer.stop(), redis.stop()]);
    },
  };
}

export interface SeededEvent {
  eventId: string;
  seatIds: string[];
}

/** Inserts an on-sale event with `seatCount` seats priced at 50.00 each. */
export async function seedEvent(
  databaseUrl: string,
  seatCount: number,
  opts: { saleOpensInMs?: number; maxSeatsPerOrder?: number } = {},
): Promise<SeededEvent> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO events (name, venue, starts_at, sale_opens_at, max_seats_per_order)
       VALUES ('Test Event', 'Test Arena', now() + interval '30 days',
               now() + make_interval(secs => $1::double precision / 1000), $2)
       RETURNING id`,
      [opts.saleOpensInMs ?? -60_000, opts.maxSeatsPerOrder ?? 4],
    );
    const eventId = rows[0]!.id;
    const seatIds = Array.from({ length: seatCount }, (_, i) => `S-${i + 1}`);
    await client.query(
      `INSERT INTO seats (event_id, seat_id, section, price_cents)
       SELECT $1, unnest($2::text[]), 'FLOOR', 5000`,
      [eventId, seatIds],
    );
    return { eventId, seatIds };
  } finally {
    await client.end();
  }
}
