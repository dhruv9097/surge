import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { Gauge, register } from 'prom-client';
import type { DatabaseConfig } from '../config/config.js';

/**
 * Thin wrapper over a pg Pool. Services write plain SQL: the hot paths in this
 * system depend on specific locking and constraint behaviour, so the SQL is
 * kept visible rather than generated.
 *
 * Designed to sit behind PgBouncer in transaction mode: no session state
 * (SET, LISTEN, advisory session locks) and no named prepared statements.
 */
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  readonly pool: Pool;

  constructor(config: DatabaseConfig) {
    this.pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: config.DB_POOL_MAX,
      connectionTimeoutMillis: config.DB_CONNECT_TIMEOUT_MS,
      query_timeout: config.DB_QUERY_TIMEOUT_MS,
      idleTimeoutMillis: 30_000,
    });
    // An idle client losing its connection emits here; without a listener
    // the process would crash on a transient database blip.
    this.pool.on('error', (err) => this.logger.error({ err }, 'Idle database client error'));
    this.registerPoolMetrics();
  }

  async query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
    return this.pool.query<T>(text, params);
  }

  /**
   * Runs `fn` inside a transaction on a single connection. Rolls back on any
   * thrown error and always releases the connection.
   *
   * While checked out, a client's connection errors are emitted on the client
   * itself, not the pool. Without a listener, a connection dropped while the
   * transaction awaits other I/O (say, a Kafka send) would crash the process.
   * Broken connections are destroyed instead of returned to the pool.
   */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    const onError = (err: Error) => {
      broken = err;
      this.logger.warn({ err }, 'Connection lost during transaction');
    };
    client.on('error', onError);
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      if (!broken) {
        await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
          broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
          this.logger.error({ err: rollbackErr }, 'Rollback failed');
        });
      }
      throw err;
    } finally {
      client.off('error', onError);
      client.release(broken);
    }
  }

  async onApplicationShutdown() {
    await this.pool.end();
  }

  // Pool saturation (waiting > 0) is one of the earliest signs of trouble:
  // it shows up well before request latency or error rates move.
  private registerPoolMetrics() {
    const pool = this.pool;
    const gauges: [string, string, () => number][] = [
      ['db_pool_connections_total', 'Open connections in the pool', () => pool.totalCount],
      ['db_pool_connections_idle', 'Idle connections in the pool', () => pool.idleCount],
      ['db_pool_requests_waiting', 'Queries waiting for a connection', () => pool.waitingCount],
    ];
    for (const [name, help, read] of gauges) {
      register.removeSingleMetric(name);
      new Gauge({
        name,
        help,
        collect() {
          this.set(read());
        },
      });
    }
  }
}
