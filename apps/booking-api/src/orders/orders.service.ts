import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiError, DatabaseService, type OrderCreatedEvent, Topics } from '@surge/common';
import { DatabaseError, type PoolClient } from 'pg';
import { Counter } from 'prom-client';
import { EventsService } from '../events/events.service.js';
import { InventoryService } from '../inventory/inventory.service.js';

export interface Order {
  orderId: string;
  eventId: string;
  userId: string;
  holdId: string;
  status: 'pending' | 'confirmed' | 'cancelled';
  seatIds: string[];
  totalCents: number;
  createdAt: string;
}

interface OrderRow {
  id: string;
  event_id: string;
  user_id: string;
  hold_id: string;
  status: Order['status'];
  seat_ids: string[];
  total_cents: number;
  created_at: Date;
}

const ORDER_COLUMNS = 'id, event_id, user_id, hold_id, status, seat_ids, total_cents, created_at';

// Each increment is a double-sale that Redis let through and Postgres stopped.
// Non-zero is expected only after Redis data loss or extreme clock edge cases.
const oversellPrevented = new Counter({
  name: 'oversell_prevented_total',
  help: 'Checkouts rejected by the database seat uniqueness guard',
});

@Injectable()
export class OrdersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly events: EventsService,
    private readonly inventory: InventoryService,
  ) {}

  /**
   * Turns a hold into an order. Safe to retry: the same idempotency key (or
   * the same hold) always resolves to the same order, including when two
   * identical requests race each other.
   */
  async checkout(
    eventId: string,
    holdId: string,
    userId: string,
    idempotencyKey: string,
  ): Promise<{ order: Order; created: boolean }> {
    const previous = await this.findOne('user_id = $1 AND idempotency_key = $2', [
      userId,
      idempotencyKey,
    ]);
    if (previous) return { order: replay(previous, holdId), created: false };

    const hold = await this.inventory.getHold(eventId, holdId);
    if (!hold || hold.userId !== userId) {
      // A concurrent request may already have converted this hold.
      const converted = await this.findOne('hold_id = $1 AND user_id = $2', [holdId, userId]);
      if (converted) return { order: converted, created: false };
      throw new ApiError(HttpStatus.GONE, 'HOLD_EXPIRED', 'Hold not found or expired');
    }

    const event = await this.events.get(eventId);
    const prices = new Map(event.seats.map((s) => [s.seatId, s.priceCents]));
    const totalCents = hold.seatIds.reduce((sum, id) => sum + (prices.get(id) ?? 0), 0);

    let order: Order;
    try {
      order = await this.db.transaction((client) =>
        this.insertOrder(
          client,
          { eventId, userId, holdId, idempotencyKey, totalCents },
          hold.seatIds,
        ),
      );
    } catch (err) {
      if (!(err instanceof DatabaseError) || err.code !== '23505') throw err;
      if (err.constraint === 'seat_sales_pkey') {
        oversellPrevented.inc();
        throw new ApiError(
          HttpStatus.CONFLICT,
          'SEATS_UNAVAILABLE',
          'Seats were sold to someone else',
        );
      }
      // Lost a race against an identical request: return the winner's order.
      const winner =
        (await this.findOne('user_id = $1 AND idempotency_key = $2', [userId, idempotencyKey])) ??
        (await this.findOne('hold_id = $1 AND user_id = $2', [holdId, userId]));
      if (!winner) throw err;
      return { order: replay(winner, holdId), created: false };
    }

    await this.inventory.commit(eventId, userId, holdId, order.seatIds);
    return { order, created: true };
  }

  async getForUser(orderId: string, userId: string): Promise<Order> {
    const order = await this.findOne('id = $1 AND user_id = $2', [orderId, userId]);
    if (!order) throw new ApiError(HttpStatus.NOT_FOUND, 'ORDER_NOT_FOUND', 'Order not found');
    return order;
  }

  private async insertOrder(
    client: PoolClient,
    o: {
      eventId: string;
      userId: string;
      holdId: string;
      idempotencyKey: string;
      totalCents: number;
    },
    seatIds: string[],
  ): Promise<Order> {
    const { rows } = await client.query<OrderRow>(
      `INSERT INTO orders (event_id, user_id, hold_id, idempotency_key, seat_ids, total_cents)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${ORDER_COLUMNS}`,
      [o.eventId, o.userId, o.holdId, o.idempotencyKey, seatIds, o.totalCents],
    );
    const order = toOrder(rows[0]!);

    // The oversell guard: the primary key rejects a seat already in a live order.
    await client.query(
      `INSERT INTO seat_sales (event_id, seat_id, order_id)
       SELECT $1, unnest($2::text[]), $3`,
      [o.eventId, seatIds, order.orderId],
    );

    const event: OrderCreatedEvent = {
      type: 'order.created',
      orderId: order.orderId,
      eventId: order.eventId,
      userId: order.userId,
      holdId: order.holdId,
      seatIds: order.seatIds,
      totalCents: order.totalCents,
      createdAt: order.createdAt,
    };
    await client.query(`INSERT INTO outbox (topic, key, payload) VALUES ($1, $2, $3)`, [
      Topics.ORDERS,
      order.orderId,
      JSON.stringify(event),
    ]);
    return order;
  }

  private async findOne(where: string, params: unknown[]): Promise<Order | null> {
    const { rows } = await this.db.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE ${where}`,
      params,
    );
    return rows[0] ? toOrder(rows[0]) : null;
  }
}

function replay(order: Order, holdId: string): Order {
  if (order.holdId !== holdId) {
    throw new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'IDEMPOTENCY_KEY_REUSED',
      'Idempotency key was already used for a different hold',
    );
  }
  return order;
}

function toOrder(row: OrderRow): Order {
  return {
    orderId: row.id,
    eventId: row.event_id,
    userId: row.user_id,
    holdId: row.hold_id,
    status: row.status,
    seatIds: row.seat_ids,
    totalCents: row.total_cents,
    createdAt: row.created_at.toISOString(),
  };
}
