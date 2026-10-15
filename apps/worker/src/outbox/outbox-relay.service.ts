import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { DatabaseService } from '@surge/common';
import { Counter, Gauge, register } from 'prom-client';
import { APP_CONFIG, type Config } from '../config.js';
import { KafkaService } from '../kafka/kafka.service.js';

interface OutboxRow {
  id: string;
  topic: string;
  key: string;
  payload: { type?: string };
}

const published = new Counter({
  name: 'outbox_published_total',
  help: 'Outbox events relayed to Kafka',
});
const relayErrors = new Counter({
  name: 'outbox_relay_errors_total',
  help: 'Failed outbox relay batches (retried)',
});

/**
 * Moves committed outbox rows to Kafka.
 *
 * Each batch is claimed with FOR UPDATE SKIP LOCKED, so any number of worker
 * replicas can relay in parallel without sending the same row twice. A row is
 * only marked published after Kafka acknowledges it; if the process dies in
 * between, the row is sent again on restart (at-least-once delivery), which
 * consumers absorb by being idempotent.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelayService.name);
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;
  private lastCleanup = 0;

  constructor(
    private readonly db: DatabaseService,
    private readonly kafka: KafkaService,
    @Inject(APP_CONFIG) private readonly config: Config,
  ) {
    // Age of the oldest unpublished event: the single best signal that the
    // pipeline is stuck, long before customers notice missing confirmations.
    const readAge = () => this.oldestUnpublishedAgeSeconds();
    register.removeSingleMetric('outbox_oldest_unpublished_age_seconds');
    new Gauge({
      name: 'outbox_oldest_unpublished_age_seconds',
      help: 'Age of the oldest outbox event not yet relayed to Kafka',
      async collect() {
        this.set(await readAge());
      },
    });
  }

  onApplicationBootstrap() {
    this.running = true;
    this.loop = this.run();
  }

  async onApplicationShutdown() {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  /** Relays one batch. Returns how many rows were published. */
  async relayBatch(): Promise<number> {
    return this.db.transaction(async (client) => {
      const { rows } = await client.query<OutboxRow>(
        `SELECT id, topic, key, payload
           FROM outbox
          WHERE published_at IS NULL
          ORDER BY id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [this.config.OUTBOX_BATCH_SIZE],
      );
      if (rows.length === 0) return 0;

      await this.kafka.producer.send({
        messages: rows.map((row) => ({
          topic: row.topic,
          key: row.key,
          value: JSON.stringify(row.payload),
          headers: { 'event-type': row.payload.type ?? 'unknown', 'outbox-id': row.id },
        })),
      });

      await client.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])', [
        rows.map((r) => r.id),
      ]);
      published.inc(rows.length);
      return rows.length;
    });
  }

  private async run() {
    let failures = 0;
    while (this.running) {
      try {
        const count = await this.relayBatch();
        failures = 0;
        await this.cleanupIfDue();
        // A full batch means there is probably more waiting: go again at once.
        if (count < this.config.OUTBOX_BATCH_SIZE)
          await this.sleep(this.config.OUTBOX_IDLE_POLL_MS);
      } catch (err) {
        failures++;
        relayErrors.inc();
        const backoff = Math.min(100 * 2 ** failures, 10_000);
        this.logger.error({ err, failures, backoffMs: backoff }, 'Outbox relay failed');
        await this.sleep(backoff);
      }
    }
  }

  /** Published rows are kept for a while for debugging, then deleted. */
  private async cleanupIfDue() {
    if (Date.now() - this.lastCleanup < 60 * 60_000) return;
    this.lastCleanup = Date.now();
    const { rowCount } = await this.db.query(
      `DELETE FROM outbox
        WHERE published_at < now() - make_interval(hours => $1)`,
      [this.config.OUTBOX_RETENTION_HOURS],
    );
    if (rowCount) this.logger.log({ deleted: rowCount }, 'Cleaned up published outbox rows');
  }

  private async oldestUnpublishedAgeSeconds(): Promise<number> {
    const { rows } = await this.db.query<{ age: number | null }>(
      `SELECT extract(epoch FROM now() - min(created_at))::float8 AS age
         FROM outbox WHERE published_at IS NULL`,
    );
    return rows[0]?.age ?? 0;
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
