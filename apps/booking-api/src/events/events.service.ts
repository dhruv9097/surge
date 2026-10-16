import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiError, DatabaseService, TtlCache } from '@surge/common';

export interface Seat {
  seatId: string;
  section: string;
  priceCents: number;
}

export interface EventDetails {
  id: string;
  name: string;
  venue: string;
  startsAt: string;
  saleOpensAt: string;
  maxSeatsPerOrder: number;
  seats: Seat[];
}

/**
 * Event catalog. Seat maps are read on every page view during a sale but
 * almost never change, so each instance caches them for a few seconds and
 * the database sees roughly one read per event per instance per TTL.
 */
@Injectable()
export class EventsService {
  private readonly cache = new TtlCache<EventDetails | null>(10_000);

  constructor(private readonly db: DatabaseService) {}

  async get(eventId: string): Promise<EventDetails> {
    const event = await this.cache.get(eventId, () => this.load(eventId));
    if (!event) throw new ApiError(HttpStatus.NOT_FOUND, 'EVENT_NOT_FOUND', 'Event not found');
    return event;
  }

  private async load(eventId: string): Promise<EventDetails | null> {
    const { rows } = await this.db.query<{
      id: string;
      name: string;
      venue: string;
      starts_at: Date;
      sale_opens_at: Date;
      max_seats_per_order: number;
      seats: Seat[] | null;
    }>(
      `SELECT e.id, e.name, e.venue, e.starts_at, e.sale_opens_at, e.max_seats_per_order,
              (SELECT json_agg(json_build_object(
                        'seatId', s.seat_id, 'section', s.section, 'priceCents', s.price_cents)
                      ORDER BY s.seat_id)
                 FROM seats s WHERE s.event_id = e.id) AS seats
         FROM events e
        WHERE e.id = $1`,
      [eventId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      venue: row.venue,
      startsAt: row.starts_at.toISOString(),
      saleOpensAt: row.sale_opens_at.toISOString(),
      maxSeatsPerOrder: row.max_seats_per_order,
      seats: row.seats ?? [],
    };
  }
}
