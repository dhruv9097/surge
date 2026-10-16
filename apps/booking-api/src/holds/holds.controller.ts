import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { type Admission, ApiError, ZodValidationPipe } from '@surge/common';
import { z } from 'zod';
import { Admitted, AdmissionGuard } from '../common/admission.guard.js';
import { APP_CONFIG, type Config } from '../config.js';
import { EventsService } from '../events/events.service.js';
import { InventoryService } from '../inventory/inventory.service.js';

const uuidPipe = new ZodValidationPipe(z.uuid());

// Seat ids are joined with commas inside Redis, so the format is strict.
const createHoldSchema = z.object({
  seatIds: z
    .array(z.string().regex(/^[A-Za-z0-9-]{1,16}$/, 'Invalid seat id'))
    .min(1)
    .max(10)
    .transform((ids) => [...new Set(ids)]),
});

@Controller('events/:eventId/holds')
@UseGuards(AdmissionGuard)
export class HoldsController {
  constructor(
    private readonly events: EventsService,
    private readonly inventory: InventoryService,
    @Inject(APP_CONFIG) private readonly config: Config,
  ) {}

  /** Reserves seats for a few minutes while the buyer checks out. */
  @Post()
  async create(
    @Param('eventId', uuidPipe) eventId: string,
    @Body(new ZodValidationPipe(createHoldSchema)) body: z.infer<typeof createHoldSchema>,
    @Admitted() { userId }: Admission,
  ) {
    const event = await this.events.get(eventId);
    if (Date.now() < Date.parse(event.saleOpensAt)) {
      throw new ApiError(HttpStatus.FORBIDDEN, 'SALE_NOT_OPEN', 'Sale has not opened yet', {
        saleOpensAt: event.saleOpensAt,
      });
    }
    if (body.seatIds.length > event.maxSeatsPerOrder) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'TOO_MANY_SEATS',
        `At most ${event.maxSeatsPerOrder} seats per order`,
      );
    }

    const holdId = randomUUID();
    const result = await this.inventory.hold(
      eventId,
      userId,
      holdId,
      body.seatIds,
      this.config.HOLD_TTL_MS,
    );
    if (result.ok) {
      return {
        holdId,
        eventId,
        seatIds: body.seatIds,
        expiresAt: new Date(result.expiresAt).toISOString(),
      };
    }
    switch (result.reason) {
      case 'UNAVAILABLE':
        throw new ApiError(HttpStatus.CONFLICT, 'SEATS_UNAVAILABLE', 'Seats are not available', {
          seatIds: result.seatIds,
        });
      case 'ALREADY_HOLDING':
        throw new ApiError(
          HttpStatus.CONFLICT,
          'ALREADY_HOLDING',
          'You already hold seats for this event',
          { holdId: result.holdId },
        );
      case 'UNKNOWN_SEAT':
        throw new ApiError(HttpStatus.BAD_REQUEST, 'UNKNOWN_SEAT', 'Seat does not exist', {
          seatId: result.seatId,
        });
    }
  }

  @Delete(':holdId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async release(
    @Param('eventId', uuidPipe) eventId: string,
    @Param('holdId', uuidPipe) holdId: string,
    @Admitted() { userId }: Admission,
  ) {
    if (!(await this.inventory.release(eventId, userId, holdId))) {
      throw new ApiError(HttpStatus.NOT_FOUND, 'HOLD_NOT_FOUND', 'Hold not found or expired');
    }
  }
}
