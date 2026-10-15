-- Up Migration

CREATE TABLE events (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  name                text NOT NULL,
  venue               text NOT NULL,
  starts_at           timestamptz NOT NULL,
  sale_opens_at       timestamptz NOT NULL,
  max_seats_per_order smallint NOT NULL DEFAULT 4 CHECK (max_seats_per_order BETWEEN 1 AND 10),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE seats (
  event_id    uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  seat_id     text NOT NULL,
  section     text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  PRIMARY KEY (event_id, seat_id)
);

CREATE TYPE order_status AS ENUM ('pending', 'confirmed', 'cancelled');

CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  event_id        uuid NOT NULL REFERENCES events (id),
  user_id         uuid NOT NULL,
  -- A hold can be turned into at most one order.
  hold_id         uuid NOT NULL UNIQUE,
  idempotency_key text NOT NULL,
  seat_ids        text[] NOT NULL,
  total_cents     integer NOT NULL CHECK (total_cents >= 0),
  status          order_status NOT NULL DEFAULT 'pending',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Retried checkouts with the same key resolve to the same order.
  CONSTRAINT orders_user_idempotency_key UNIQUE (user_id, idempotency_key)
);

CREATE INDEX orders_event_status ON orders (event_id, status);

-- The final guard against overselling. Redis decides who may *try* to buy a
-- seat; this primary key decides who actually gets it. A seat can belong to at
-- most one live order, whatever happens to Redis. Cancelling an order deletes
-- its rows, which puts the seats back on sale.
CREATE TABLE seat_sales (
  event_id uuid NOT NULL,
  seat_id  text NOT NULL,
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT seat_sales_pkey PRIMARY KEY (event_id, seat_id),
  FOREIGN KEY (event_id, seat_id) REFERENCES seats (event_id, seat_id)
);

CREATE INDEX seat_sales_order ON seat_sales (order_id);

-- Transactional outbox: events are written in the same transaction as the
-- state change they describe, then relayed to Kafka. No dual writes, so an
-- order can never exist without its event, or the reverse.
CREATE TABLE outbox (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic        text NOT NULL,
  key          text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;

-- Down Migration

DROP TABLE outbox;
DROP TABLE seat_sales;
DROP TABLE orders;
DROP TYPE order_status;
DROP TABLE seats;
DROP TABLE events;
