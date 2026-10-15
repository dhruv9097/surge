/**
 * Kafka topics and event payloads shared by producers and consumers.
 *
 * Delivery is at-least-once (outbox relay + manual offset commits), so every
 * consumer must be idempotent: the same event may arrive more than once.
 * Events for one order share a key (the order id), so they land on the same
 * partition and are consumed in the order they were published.
 */
export const Topics = {
  ORDERS: 'orders',
  ORDERS_DLQ: 'orders.dlq',
} as const;

export interface OrderSnapshot {
  orderId: string;
  eventId: string;
  userId: string;
  seatIds: string[];
  totalCents: number;
}

export interface OrderCreatedEvent extends OrderSnapshot {
  type: 'order.created';
  holdId: string;
  createdAt: string;
}

export interface OrderConfirmedEvent extends OrderSnapshot {
  type: 'order.confirmed';
  confirmedAt: string;
}

export type OrderEvent = OrderCreatedEvent | OrderConfirmedEvent;
