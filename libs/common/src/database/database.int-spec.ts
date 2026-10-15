import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { DatabaseService } from './database.service.js';

describe('DatabaseService (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let db: DatabaseService;
  let admin: pg.Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.6-trixie').start();
    db = new DatabaseService({
      DATABASE_URL: container.getConnectionUri(),
      DB_POOL_MAX: 2,
      DB_QUERY_TIMEOUT_MS: 5_000,
      DB_CONNECT_TIMEOUT_MS: 2_000,
    });
    admin = new pg.Client({ connectionString: container.getConnectionUri() });
    await admin.connect();
  });

  afterAll(async () => {
    await admin?.end();
    await db?.onApplicationShutdown();
    await container?.stop();
  });

  it('commits and rolls back', async () => {
    await db.query('CREATE TABLE t (v int)');
    await db.transaction((c) => c.query('INSERT INTO t VALUES (1)'));
    await expect(
      db.transaction(async (c) => {
        await c.query('INSERT INTO t VALUES (2)');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { rows } = await db.query<{ v: number }>('SELECT v FROM t');
    expect(rows).toEqual([{ v: 1 }]);
  });

  // Regression: a connection dropped while a transaction was waiting on other
  // I/O (e.g. a Kafka send) used to surface as an uncaught exception and kill
  // the process. It must instead fail just that transaction.
  it('survives the connection dying mid-transaction and recovers', async () => {
    const result = db.transaction(async (client) => {
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await admin.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);
      // Idle in the transaction while the server-side kill lands.
      await new Promise((r) => setTimeout(r, 300));
      await client.query('SELECT 1');
    });
    await expect(result).rejects.toThrow();

    // The broken connection was discarded, not returned to the pool.
    const { rows } = await db.query<{ ok: number }>('SELECT 1 AS ok');
    expect(rows).toEqual([{ ok: 1 }]);
  });
});
