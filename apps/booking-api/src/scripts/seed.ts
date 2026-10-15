/**
 * Creates an on-sale event for local runs and load tests.
 *
 *   docker compose run --rm booking-api node dist/scripts/seed.js [seats] [name]
 *
 * Seats are laid out in rows of 25 (A-1 … A-25, B-1 …) with pricier front rows.
 * Prints the new event id as the last line of output.
 */
import pg from 'pg';

const seatCount = Number(process.argv[2] ?? 1_000);
const name = process.argv[3] ?? 'Surge Live';
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!Number.isInteger(seatCount) || seatCount < 1 || seatCount > 100_000) {
  throw new Error('seats must be an integer between 1 and 100000');
}

const ROW_SIZE = 25;
const rowName = (i: number) => {
  let n = Math.floor(i / ROW_SIZE);
  let label = '';
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
};

const seats = Array.from({ length: seatCount }, (_, i) => {
  const row = Math.floor(i / ROW_SIZE);
  return {
    seatId: `${rowName(i)}-${(i % ROW_SIZE) + 1}`,
    section: row < 4 ? 'FRONT' : 'MAIN',
    priceCents: row < 4 ? 15_000 : 7_500,
  };
});

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query('BEGIN');
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO events (name, venue, starts_at, sale_opens_at)
     VALUES ($1, 'Surge Arena', now() + interval '30 days', now())
     RETURNING id`,
    [name],
  );
  const eventId = rows[0]!.id;
  await client.query(
    `INSERT INTO seats (event_id, seat_id, section, price_cents)
     SELECT $1, unnest($2::text[]), unnest($3::text[]), unnest($4::int[])`,
    [
      eventId,
      seats.map((s) => s.seatId),
      seats.map((s) => s.section),
      seats.map((s) => s.priceCents),
    ],
  );
  await client.query('COMMIT');
  console.log(`Created "${name}" with ${seatCount} seats`);
  console.log(eventId);
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}
