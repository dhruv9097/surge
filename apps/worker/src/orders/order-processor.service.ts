import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import type { Message, MessagesStream } from '@platformatic/kafka';
import { DatabaseService, type OrderEvent, Topics } from '@surge/common';
import { Counter } from 'prom-client';
import { APP_CONFIG, type Config } from '../config.js';
import { KafkaService } from '../kafka/kafka.service.js';

type StringMessage = Message<string, string, string, string>;
export type ProcessOutcome = 'confirmed' | 'duplicate' | 'ignored';

const processed = new Counter({
  name: 'order_events_processed_total',
  help: 'Order events processed by outcome',
  labelNames: ['outcome'],
});

export const CONSUMER_GROUP = 'order-processor';

/**
 * Confirms orders from `order.created` events.
 *
 * Offsets are committed only after an event is fully handled, so a crash
 * replays it rather than losing it. Handling is idempotent (a conditional
 * update), so replays and duplicate deliveries are harmless. An event that
 * keeps failing is parked on the dead-letter topic after a bounded number of
 * attempts, so one poison message cannot stall its whole partition.
 */
@Injectable()
export class OrderProcessorService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OrderProcessorService.name);
  private stream?: MessagesStream<string, string, string, string>;
  private loop?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly kafka: KafkaService,
    @Inject(APP_CONFIG) private readonly config: Config,
  ) {}

  async onApplicationBootstrap() {
    const consumer = this.kafka.createConsumer(CONSUMER_GROUP);
    this.stream = await consumer.consume({
      topics: [Topics.ORDERS],
      mode: 'committed',
      fallbackMode: 'earliest',
      autocommit: false,
      sessionTimeout: 15_000,
      heartbeatInterval: 1_000,
    });
    this.loop = this.consume(this.stream);
  }

  async onApplicationShutdown() {
    this.stopping = true;
    await this.stream?.close();
    await this.loop;
  }

  /** Applies one event. Exposed for tests; the consumer loop is the caller in production. */
  async handle(event: OrderEvent): Promise<ProcessOutcome> {
    if (event.type !== 'order.created') return 'ignored';

    // Confirm and enqueue the follow-up event in one atomic statement. If the
    // order is no longer pending, this was a duplicate and nothing happens.
    const { rowCount } = await this.db.query(
      `WITH confirmed AS (
         UPDATE orders SET status = 'confirmed', updated_at = now()
          WHERE id = $1 AND status = 'pending'
          RETURNING id, event_id, user_id, seat_ids, total_cents, updated_at
       )
       INSERT INTO outbox (topic, key, payload)
       SELECT $2, id::text, json_build_object(
                'type', 'order.confirmed',
                'orderId', id, 'eventId', event_id, 'userId', user_id,
                'seatIds', seat_ids, 'totalCents', total_cents, 'confirmedAt', updated_at)
         FROM confirmed`,
      [event.orderId, Topics.ORDERS],
    );
    return rowCount === 1 ? 'confirmed' : 'duplicate';
  }

  private async consume(stream: MessagesStream<string, string, string, string>) {
    try {
      for await (const message of stream) {
        await this.processWithRetry(message);
        await message.commit();
      }
    } catch (err) {
      if (!this.stopping) this.logger.error({ err }, 'Order consumer stopped unexpectedly');
    }
  }

  private async processWithRetry(message: StringMessage) {
    for (let attempt = 1; ; attempt++) {
      try {
        const outcome = await this.handle(JSON.parse(message.value) as OrderEvent);
        processed.inc({ outcome });
        return;
      } catch (err) {
        if (attempt >= this.config.PROCESSING_MAX_ATTEMPTS || this.stopping) {
          await this.deadLetter(message, err);
          return;
        }
        const backoff = Math.min(100 * 2 ** attempt, 5_000) * (0.5 + Math.random());
        this.logger.warn({ err, attempt, key: message.key }, 'Order event failed, retrying');
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  private async deadLetter(message: StringMessage, err: unknown) {
    processed.inc({ outcome: 'dead_lettered' });
    this.logger.error(
      { err, key: message.key, partition: message.partition, offset: String(message.offset) },
      'Order event moved to dead-letter topic',
    );
    await this.kafka.producer.send({
      messages: [
        {
          topic: Topics.ORDERS_DLQ,
          key: message.key,
          value: message.value,
          headers: {
            'dlq-reason': err instanceof Error ? err.message.slice(0, 500) : 'unknown',
            'dlq-source': `${message.topic}/${message.partition}/${message.offset}`,
          },
        },
      ],
    });
  }
}
