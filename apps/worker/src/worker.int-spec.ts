import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  Admin,
  Consumer,
  Producer,
  stringDeserializers,
  stringSerializers,
} from '@platformatic/kafka';
import { Topics } from '@surge/common';
import { OrderProcessorService } from './orders/order-processor.service.js';
import { OutboxRelayService } from './outbox/outbox-relay.service.js';
import {
  createWorkerApp,
  insertPendingOrder,
  startInfra,
  waitFor,
  type WorkerInfra,
} from './test-support/infra.js';

const orderStatus = async (infra: WorkerInfra, orderId: string) =>
  (await infra.db.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [orderId]))
    .rows[0]?.status;

const outboxCount = async (infra: WorkerInfra, orderId: string, type: string) =>
  (
    await infra.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE key = $1 AND payload->>'type' = $2`,
      [orderId, type],
    )
  ).rows[0]!.n;

describe('worker (integration)', () => {
  let infra: WorkerInfra;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    infra = await startInfra();
    app = await createWorkerApp(infra, { PROCESSING_MAX_ATTEMPTS: '2' });
  });

  afterAll(async () => {
    await app?.close();
    await infra?.stop();
  });

  it('confirms an order end to end: outbox -> Kafka -> consumer -> database', async () => {
    const event = await insertPendingOrder(infra.db);

    await waitFor(async () => (await orderStatus(infra, event.orderId)) === 'confirmed');

    // The follow-up event was written by the same statement that confirmed it,
    // and the relay publishes it too.
    expect(await outboxCount(infra, event.orderId, 'order.confirmed')).toBe(1);
    await waitFor(async () => {
      const { rows } = await infra.db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM outbox WHERE key = $1 AND published_at IS NULL',
        [event.orderId],
      );
      return rows[0]!.n === 0;
    });
  });

  it('confirms exactly once when the same event is delivered several times', async () => {
    const event = await insertPendingOrder(infra.db, 3);

    await waitFor(async () => (await orderStatus(infra, event.orderId)) === 'confirmed');
    // Give the duplicates time to arrive and be processed.
    await waitFor(async () => {
      const { rows } = await infra.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM outbox WHERE key = $1 AND published_at IS NULL`,
        [event.orderId],
      );
      return rows[0]!.n === 0;
    });
    await new Promise((r) => setTimeout(r, 1_000));

    expect(await outboxCount(infra, event.orderId, 'order.confirmed')).toBe(1);
  });

  it('treats a replayed event as a no-op', async () => {
    const event = await insertPendingOrder(infra.db, 0);
    const processor = app.get(OrderProcessorService);
    expect(await processor.handle(event)).toBe('confirmed');
    expect(await processor.handle(event)).toBe('duplicate');
    expect(await outboxCount(infra, event.orderId, 'order.confirmed')).toBe(1);
  });

  it('never publishes a row twice when relays run concurrently', async () => {
    // A second worker instance competing for the same outbox rows.
    const second = await createWorkerApp(infra, { OUTBOX_BATCH_SIZE: '25' });
    const relays = [app.get(OutboxRelayService), second.get(OutboxRelayService)];
    try {
      const admin = new Admin({ clientId: 'relay-test', bootstrapBrokers: [infra.brokers] });
      await admin.createTopics({ topics: ['relay-test'], partitions: 3, replicas: 1 });
      await admin.close();

      const { rows } = await infra.db.query<{ id: string }>(
        `INSERT INTO outbox (topic, key, payload)
         SELECT 'relay-test', 'k' || g, json_build_object('type', 'test', 'n', g)
           FROM generate_series(1, 300) g
         RETURNING id`,
      );
      const ids = rows.map((r) => r.id);

      // Drive both relays hard, in parallel with their own background loops.
      await Promise.all(
        relays.map(async (relay) => {
          for (let i = 0; i < 20; i++) await relay.relayBatch();
        }),
      );
      await waitFor(async () => {
        const { rows: left } = await infra.db.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM outbox WHERE id = ANY($1::bigint[]) AND published_at IS NULL',
          [ids],
        );
        return left[0]!.n === 0;
      });

      // Count what actually reached Kafka, per outbox id.
      const consumer = new Consumer({
        groupId: `relay-audit-${Date.now()}`,
        clientId: 'relay-audit',
        bootstrapBrokers: [infra.brokers],
        deserializers: stringDeserializers,
      });
      const seen = new Map<string, number>();
      const stream = await consumer.consume({
        topics: ['relay-test'],
        mode: 'earliest',
        autocommit: false,
      });
      try {
        for await (const message of stream) {
          const id = message.headers.get('outbox-id')!;
          seen.set(id, (seen.get(id) ?? 0) + 1);
          if (seen.size === ids.length) break;
        }
      } finally {
        await stream.close();
        await consumer.close();
      }
      expect(seen.size).toBe(300);
      expect([...seen.values()].every((n) => n === 1)).toBe(true);
    } finally {
      await second.close();
    }
  });

  it('parks a poison message on the dead-letter topic and keeps going', async () => {
    const producer = new Producer({
      clientId: 'poison-test',
      bootstrapBrokers: [infra.brokers],
      serializers: stringSerializers,
    });
    await producer.send({
      messages: [{ topic: Topics.ORDERS, key: 'poison', value: '{not json' }],
    });
    await producer.close();

    // The partition is not blocked: a normal order behind it still confirms.
    const event = await insertPendingOrder(infra.db);
    await waitFor(async () => (await orderStatus(infra, event.orderId)) === 'confirmed');

    const consumer = new Consumer({
      groupId: `dlq-audit-${Date.now()}`,
      clientId: 'dlq-audit',
      bootstrapBrokers: [infra.brokers],
      deserializers: stringDeserializers,
    });
    const stream = await consumer.consume({
      topics: [Topics.ORDERS_DLQ],
      mode: 'earliest',
      autocommit: false,
    });
    try {
      for await (const message of stream) {
        if (message.key !== 'poison') continue;
        expect(message.value).toBe('{not json');
        expect(message.headers.get('dlq-reason')).toMatch(/JSON/);
        break;
      }
    } finally {
      await stream.close();
      await consumer.close();
    }
  });
});
