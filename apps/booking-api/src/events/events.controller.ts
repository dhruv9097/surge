import { Controller, Get, Param } from '@nestjs/common';
import { ZodValidationPipe } from '@surge/common';
import { z } from 'zod';
import { InventoryService } from '../inventory/inventory.service.js';
import { EventsService } from './events.service.js';

const eventIdPipe = new ZodValidationPipe(z.uuid());

@Controller('events/:eventId')
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly inventory: InventoryService,
  ) {}

  @Get()
  get(@Param('eventId', eventIdPipe) eventId: string) {
    return this.events.get(eventId);
  }

  /** Live seat state, served from Redis so it never touches Postgres. */
  @Get('availability')
  async availability(@Param('eventId', eventIdPipe) eventId: string) {
    const event = await this.events.get(eventId);
    const { held, sold } = await this.inventory.availability(eventId);
    // A seat can briefly be in both sets while a sale is being committed.
    const unavailable = new Set([...held, ...sold]).size;
    return {
      eventId,
      total: event.seats.length,
      available: event.seats.length - unavailable,
      held,
      sold,
    };
  }
}
