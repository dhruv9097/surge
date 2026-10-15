import { Inject, Injectable, Logger } from '@nestjs/common';
import { DatabaseService, REDIS } from '@surge/common';
import type { Redis } from 'ioredis';
import { Counter } from 'prom-client';
import { COMMIT_HOLD, HOLD_SEATS, inventoryKeys, RELEASE_HOLD } from './inventory.scripts.js';

export type HoldResult =
  | { ok: true; expiresAt: number }
  | { ok: false; reason: 'ALREADY_HOLDING'; holdId: string }
  | { ok: false; reason: 'UNKNOWN_SEAT'; seatId: string }
  | { ok: false; reason: 'UNAVAILABLE'; seatIds: string[] };

export interface ActiveHold {
  userId: string;
  seatIds: string[];
  expiresAt: number;
}

type ScriptFn = (...args: (string | number)[]) => Promise<unknown>;

const holdAttempts = new Counter({
  name: 'seat_hold_attempts_total',
  help: 'Seat hold attempts by outcome',
  labelNames: ['outcome'],
});

/**
 * Fast-path seat inventory in Redis. Redis decides who may attempt to buy a
 * seat; Postgres (seat_sales) decides who gets it. If the two ever disagree,
 * Postgres wins and Redis is rebuilt from it.
 */
@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);
  private readonly holdSeats: ScriptFn;
  private readonly releaseHold: ScriptFn;
  private readonly commitHold: ScriptFn;
  // One in-flight load per event per process, however many requests ask.
  private readonly loading = new Map<string, Promise<void>>();

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly db: DatabaseService,
  ) {
    // defineCommand caches each script server-side (EVALSHA) after first use.
    redis.defineCommand('surgeHoldSeats', { numberOfKeys: 5, lua: HOLD_SEATS });
    redis.defineCommand('surgeReleaseHold', { numberOfKeys: 3, lua: RELEASE_HOLD });
    redis.defineCommand('surgeCommitHold', { numberOfKeys: 4, lua: COMMIT_HOLD });
    const commands = redis as unknown as Record<string, ScriptFn>;
    this.holdSeats = commands.surgeHoldSeats!.bind(redis);
    this.releaseHold = commands.surgeReleaseHold!.bind(redis);
    this.commitHold = commands.surgeCommitHold!.bind(redis);
  }

  async hold(
    eventId: string,
    userId: string,
    holdId: string,
    seatIds: string[],
    ttlMs: number,
  ): Promise<HoldResult> {
    const k = inventoryKeys(eventId);
    const run = () =>
      this.holdSeats(
        k.seats,
        k.sold,
        k.held,
        k.hold(holdId),
        k.user(userId),
        holdId,
        userId,
        ttlMs,
        ...seatIds,
      ) as Promise<string[]>;

    let reply = await run();
    if (reply[0] === 'ERR_NOT_LOADED') {
      await this.ensureLoaded(eventId);
      reply = await run();
    }

    const [status, ...rest] = reply;
    const result: HoldResult =
      status === 'OK'
        ? { ok: true, expiresAt: Number(rest[0]) }
        : status === 'ERR_ALREADY_HOLDING'
          ? { ok: false, reason: 'ALREADY_HOLDING', holdId: rest[0]! }
          : status === 'ERR_UNKNOWN_SEAT'
            ? { ok: false, reason: 'UNKNOWN_SEAT', seatId: rest[0]! }
            : status === 'ERR_UNAVAILABLE'
              ? { ok: false, reason: 'UNAVAILABLE', seatIds: rest }
              : unexpected(reply);
    holdAttempts.inc({ outcome: result.ok ? 'held' : result.reason.toLowerCase() });
    return result;
  }

  async release(eventId: string, userId: string, holdId: string): Promise<boolean> {
    const k = inventoryKeys(eventId);
    const reply = await this.releaseHold(k.held, k.hold(holdId), k.user(userId), userId, holdId);
    return reply === 'OK';
  }

  async getHold(eventId: string, holdId: string): Promise<ActiveHold | null> {
    const hold = await this.redis.hgetall(inventoryKeys(eventId).hold(holdId));
    if (!hold.userId || !hold.seats || !hold.expiresAt) return null;
    return {
      userId: hold.userId,
      seatIds: hold.seats.split(','),
      expiresAt: Number(hold.expiresAt),
    };
  }

  /**
   * Best effort: the order is already durable in Postgres. If this fails the
   * hold simply expires, and any later attempt on these seats is rejected by
   * the seat_sales primary key, so correctness never depends on it.
   */
  async commit(eventId: string, userId: string, holdId: string, seatIds: string[]) {
    const k = inventoryKeys(eventId);
    try {
      await this.commitHold(k.held, k.sold, k.hold(holdId), k.user(userId), holdId, ...seatIds);
    } catch (err) {
      this.logger.warn({ err, eventId, holdId }, 'Failed to mark seats sold in Redis');
    }
  }

  async availability(eventId: string) {
    const k = inventoryKeys(eventId);
    await this.ensureLoaded(eventId);
    const now = Date.now();
    const [held, sold] = await Promise.all([
      this.redis.zrangebyscore(k.held, `(${now}`, '+inf'),
      this.redis.smembers(k.sold),
    ]);
    return { held, sold };
  }

  /**
   * Builds an event's Redis inventory from Postgres if it is not there yet
   * (first sale, or Redis lost its data). Only adds, never removes, so it is
   * safe to run concurrently with live holds and commits.
   */
  async ensureLoaded(eventId: string): Promise<void> {
    const k = inventoryKeys(eventId);
    if ((await this.redis.exists(k.seats)) === 1) return;

    let pending = this.loading.get(eventId);
    if (!pending) {
      pending = this.load(eventId).finally(() => this.loading.delete(eventId));
      this.loading.set(eventId, pending);
    }
    return pending;
  }

  private async load(eventId: string) {
    const k = inventoryKeys(eventId);
    const [seats, sold] = await Promise.all([
      this.db.query<{ seat_id: string }>('SELECT seat_id FROM seats WHERE event_id = $1', [
        eventId,
      ]),
      this.db.query<{ seat_id: string }>('SELECT seat_id FROM seat_sales WHERE event_id = $1', [
        eventId,
      ]),
    ]);
    if (seats.rowCount === 0) return;

    const tx = this.redis.multi();
    if (sold.rows.length > 0) tx.sadd(k.sold, ...sold.rows.map((r) => r.seat_id));
    // Seats last: their existence is what marks the event as loaded.
    tx.sadd(k.seats, ...seats.rows.map((r) => r.seat_id));
    await tx.exec();
    this.logger.log({ eventId, seats: seats.rowCount, sold: sold.rowCount }, 'Inventory loaded');
  }
}

function unexpected(reply: unknown): never {
  throw new Error(`Unexpected inventory script reply: ${JSON.stringify(reply)}`);
}
