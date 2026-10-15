import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { inventoryKeys } from './inventory/inventory.scripts.js';
import { buyer, createTestApp } from './test-support/app.js';
import { seedEvent, startInfra, type TestInfra } from './test-support/infra.js';

type Json = Record<string, unknown>;
const errorCode = (res: { json: () => unknown }) => (res.json() as { error: Json }).error.code;

describe('booking flow (integration)', () => {
  let infra: TestInfra;
  let app: NestFastifyApplication;
  let db: pg.Pool;
  let redis: Redis;

  beforeAll(async () => {
    infra = await startInfra();
    app = await createTestApp(infra);
    db = new pg.Pool({ connectionString: infra.databaseUrl });
    redis = new Redis(infra.redisUrl);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    redis?.disconnect();
    await infra?.stop();
  });

  describe('holds', () => {
    it('reserves free seats and blocks them for everyone else', async () => {
      const { eventId } = await seedEvent(infra.databaseUrl, 10);
      const alice = buyer(app);
      const bob = buyer(app);

      const held = await alice.hold(eventId, ['S-1', 'S-2']);
      expect(held.statusCode).toBe(201);
      expect(held.json()).toMatchObject({ eventId, seatIds: ['S-1', 'S-2'] });

      const clash = await bob.hold(eventId, ['S-2', 'S-3']);
      expect(clash.statusCode).toBe(409);
      expect(clash.json()).toMatchObject({
        error: { code: 'SEATS_UNAVAILABLE', details: { seatIds: ['S-2'] } },
      });

      // All-or-nothing: S-3 must not have been reserved by the failed attempt.
      expect((await bob.hold(eventId, ['S-3'])).statusCode).toBe(201);

      const availability = await app.inject({ url: `/events/${eventId}/availability` });
      expect(availability.json()).toMatchObject({ total: 10, available: 7 });
    });

    it('allows one active hold per buyer per event', async () => {
      const { eventId } = await seedEvent(infra.databaseUrl, 10);
      const alice = buyer(app);
      const first = await alice.hold(eventId, ['S-1']);
      const second = await alice.hold(eventId, ['S-5']);
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({
        error: { code: 'ALREADY_HOLDING', details: { holdId: first.json<Json>().holdId } },
      });
    });

    it('rejects invalid requests before touching inventory', async () => {
      const { eventId } = await seedEvent(infra.databaseUrl, 10, { maxSeatsPerOrder: 2 });
      const alice = buyer(app);
      expect(errorCode(await alice.hold(eventId, ['S-99']))).toBe('UNKNOWN_SEAT');
      expect(errorCode(await alice.hold(eventId, ['S-1', 'S-2', 'S-3']))).toBe('TOO_MANY_SEATS');
      expect(errorCode(await alice.hold(eventId, ['bad,id']))).toBe('VALIDATION_FAILED');
      expect(errorCode(await alice.hold(randomUUID(), ['S-1']))).toBe('EVENT_NOT_FOUND');

      const anonymous = await app.inject({
        method: 'POST',
        url: `/events/${eventId}/holds`,
        payload: { seatIds: ['S-1'] },
      });
      expect(errorCode(anonymous)).toBe('UNAUTHENTICATED');
    });

    it('refuses holds before the sale opens', async () => {
      const { eventId } = await seedEvent(infra.databaseUrl, 10, { saleOpensInMs: 3_600_000 });
      expect(errorCode(await buyer(app).hold(eventId, ['S-1']))).toBe('SALE_NOT_OPEN');
    });

    it('puts released seats back on sale', async () => {
      const { eventId } = await seedEvent(infra.databaseUrl, 10);
      const alice = buyer(app);
      const { holdId } = (await alice.hold(eventId, ['S-1'])).json<{ holdId: string }>();

      expect((await buyer(app).release(eventId, holdId)).statusCode).toBe(404); // not theirs
      expect((await alice.release(eventId, holdId)).statusCode).toBe(204);
      expect((await buyer(app).hold(eventId, ['S-1'])).statusCode).toBe(201);
    });
  });

  describe('checkout', () => {
    it('turns a hold into an order and marks the seats sold', async () => {
      const { eventId } = await seedEvent(infra.databaseUrl, 10);
      const alice = buyer(app);
      const { holdId } = (await alice.hold(eventId, ['S-1', 'S-2'])).json<{ holdId: string }>();

      const res = await alice.checkout(eventId, holdId);
      expect(res.statusCode).toBe(201);
      const order = res.json<Json>();
      expect(order).toMatchObject({
        eventId,
        holdId,
        status: 'pending',
        seatIds: ['S-1', 'S-2'],
        totalCents: 10_000,
      });

      expect((await alice.order(order.orderId as string)).json()).toEqual(order);
      expect((await buyer(app).order(order.orderId as string)).statusCode).toBe(404);

      const availability = await app.inject({ url: `/events/${eventId}/availability` });
      expect(availability.json()).toMatchObject({
        available: 8,
        sold: expect.arrayContaining(['S-1', 'S-2']) as unknown,
      });

      // The event is in the outbox, written in the same transaction as the order.
      const outbox = await db.query<{ payload: Json }>(
        'SELECT payload FROM outbox WHERE key = $1',
        [order.orderId],
      );
      expect(outbox.rows[0]!.payload).toMatchObject({
        type: 'order.created',
        orderId: order.orderId,
      });

      // The buyer can start a new hold once the previous one is converted.
      expect((await alice.hold(eventId, ['S-3'])).statusCode).toBe(201);
    });

    it('returns the same order when the request is retried', async () => {
      const { eventId } = await seedEvent(infra.databaseUrl, 10);
      const alice = buyer(app);
      const { holdId } = (await alice.hold(eventId, ['S-1'])).json<{ holdId: string }>();

      const first = await alice.checkout(eventId, holdId, 'retry-key-1');
      const retry = await alice.checkout(eventId, holdId, 'retry-key-1');
      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual(first.json());
    });

    it('rejects an idempotency key reused for a different hold', async () => {
      const { eventId } = await seedEvent(infra.databaseUrl, 10);
      const alice = buyer(app);
      const a = (await alice.hold(eventId, ['S-1'])).json<{ holdId: string }>();
      await alice.checkout(eventId, a.holdId, 'shared-key-1');
      const b = (await alice.hold(eventId, ['S-2'])).json<{ holdId: string }>();
      expect(errorCode(await alice.checkout(eventId, b.holdId, 'shared-key-1'))).toBe(
        'IDEMPOTENCY_KEY_REUSED',
      );
    });

    it('requires an idempotency key', async () => {
      const { eventId } = await seedEvent(infra.databaseUrl, 10);
      const alice = buyer(app);
      const { holdId } = (await alice.hold(eventId, ['S-1'])).json<{ holdId: string }>();
      const res = await app.inject({
        method: 'POST',
        url: `/events/${eventId}/holds/${holdId}/checkout`,
        headers: { 'x-user-id': alice.userId },
      });
      expect(errorCode(res)).toBe('VALIDATION_FAILED');
    });

    it('creates exactly one order when the same checkout is fired many times at once', async () => {
      const { eventId } = await seedEvent(infra.databaseUrl, 10);
      const alice = buyer(app);
      const { holdId } = (await alice.hold(eventId, ['S-1'])).json<{ holdId: string }>();

      // Same key (client retries) and different keys (double-click with a buggy client).
      const responses = await Promise.all([
        ...Array.from({ length: 10 }, () => alice.checkout(eventId, holdId, 'same-key-123')),
        ...Array.from({ length: 10 }, () => alice.checkout(eventId, holdId)),
      ]);
      const orderIds = new Set(responses.map((r) => r.json<Json>().orderId));
      expect(responses.every((r) => r.statusCode === 200 || r.statusCode === 201)).toBe(true);
      expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(orderIds.size).toBe(1);

      const count = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM orders WHERE hold_id = $1',
        [holdId],
      );
      expect(count.rows[0]!.n).toBe(1);
    });

    it('rebuilds inventory from Postgres after Redis loses its data', async () => {
      const { eventId } = await seedEvent(infra.databaseUrl, 10);
      const alice = buyer(app);
      const { holdId } = (await alice.hold(eventId, ['S-1'])).json<{ holdId: string }>();
      await alice.checkout(eventId, holdId);

      const k = inventoryKeys(eventId);
      await redis.del(k.seats, k.sold, k.held);

      const res = await buyer(app).hold(eventId, ['S-1']);
      expect(errorCode(res)).toBe('SEATS_UNAVAILABLE');
    });

    it('lets Postgres stop a double sale when Redis is wrong', async () => {
      const { eventId } = await seedEvent(infra.databaseUrl, 10);
      const alice = buyer(app);
      const bob = buyer(app);
      const a = (await alice.hold(eventId, ['S-1'])).json<{ holdId: string }>();
      await alice.checkout(eventId, a.holdId);

      // Simulate Redis drifting from the truth: S-1 looks unsold again.
      await redis.srem(inventoryKeys(eventId).sold, 'S-1');

      const b = await bob.hold(eventId, ['S-1']);
      expect(b.statusCode).toBe(201); // Redis is fooled...
      const res = await bob.checkout(eventId, b.json<{ holdId: string }>().holdId);
      expect(res.statusCode).toBe(409); // ...Postgres is not.
      expect(errorCode(res)).toBe('SEATS_UNAVAILABLE');

      const metrics = await app.inject({ url: '/metrics' });
      expect(metrics.body).toMatch(/oversell_prevented_total\{[^}]*\} [1-9]/);
    });
  });

  describe('hold expiry', () => {
    let shortHoldApp: NestFastifyApplication;

    beforeAll(async () => {
      shortHoldApp = await createTestApp(infra, { HOLD_TTL_MS: '1000' });
    });
    afterAll(() => shortHoldApp?.close());

    it('frees seats when a hold expires and refuses to check it out', async () => {
      const { eventId } = await seedEvent(infra.databaseUrl, 10);
      const alice = buyer(shortHoldApp);
      const { holdId } = (await alice.hold(eventId, ['S-1'])).json<{ holdId: string }>();

      await new Promise((r) => setTimeout(r, 1_200));

      expect(errorCode(await alice.checkout(eventId, holdId))).toBe('HOLD_EXPIRED');
      expect((await buyer(shortHoldApp).hold(eventId, ['S-1'])).statusCode).toBe(201);
    });
  });

  describe('flash sale race', () => {
    it('never sells a seat twice when 500 buyers fight over 50 seats', async () => {
      const SEATS = 50;
      const BUYERS = 500;
      const { eventId, seatIds } = await seedEvent(infra.databaseUrl, SEATS);

      // Everyone wants the same few rows, so contention is extreme.
      const pick = () => {
        const n = 1 + Math.floor(Math.random() * 2);
        const start = Math.floor(Math.random() * (SEATS - n));
        return seatIds.slice(start, start + n);
      };

      const outcomes = await Promise.all(
        Array.from({ length: BUYERS }, async () => {
          const b = buyer(app);
          const hold = await b.hold(eventId, pick());
          if (hold.statusCode !== 201) return { held: false, bought: false };
          const checkout = await b.checkout(eventId, hold.json<{ holdId: string }>().holdId);
          return { held: true, bought: checkout.statusCode === 201 };
        }),
      );

      const { rows: sales } = await db.query<{ seat_id: string; order_id: string }>(
        'SELECT seat_id, order_id FROM seat_sales WHERE event_id = $1',
        [eventId],
      );
      const { rows: orders } = await db.query<{ seat_ids: string[] }>(
        'SELECT seat_ids FROM orders WHERE event_id = $1',
        [eventId],
      );

      const soldSeats = sales.map((s) => s.seat_id);
      const seatsAcrossOrders = orders.flatMap((o) => o.seat_ids);

      // Guard against a vacuous pass: there must have been real contention
      // (most buyers lost) and real sales (a good share of seats went).
      expect(outcomes.filter((o) => !o.held).length).toBeGreaterThan(BUYERS / 2);
      expect(soldSeats.length).toBeGreaterThan(SEATS / 2);

      // No seat appears in two orders, and nothing beyond capacity was sold.
      expect(new Set(seatsAcrossOrders).size).toBe(seatsAcrossOrders.length);
      expect(new Set(soldSeats).size).toBe(soldSeats.length);
      expect(soldSeats.length).toBeLessThanOrEqual(SEATS);
      expect(orders).toHaveLength(outcomes.filter((o) => o.bought).length);
      // Every successful hold became an order: Redis only admitted real winners.
      expect(outcomes.filter((o) => o.held).length).toBe(orders.length);

      // Redis and Postgres agree on what was sold.
      const redisSold = await redis.smembers(inventoryKeys(eventId).sold);
      expect(new Set(redisSold)).toEqual(new Set(soldSeats));
    });
  });
});
