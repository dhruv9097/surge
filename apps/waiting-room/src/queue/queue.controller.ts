import {
  Controller,
  createParamDecorator,
  ExecutionContext,
  Get,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiError, ZodValidationPipe } from '@surge/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { QueueService } from './queue.service.js';

const uuid = z.uuid();
const uuidPipe = new ZodValidationPipe(uuid);

/**
 * User login is outside this system: the waiting room trusts the user id
 * set by the platform's authentication layer in front of it. Everything
 * past the waiting room requires the signed admission token it issues.
 */
const UserId = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const parsed = uuid.safeParse(
    ctx.switchToHttp().getRequest<FastifyRequest>().headers['x-user-id'],
  );
  if (!parsed.success) {
    throw new ApiError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', 'Missing or invalid user');
  }
  return parsed.data;
});

@Controller('events/:eventId/queue')
export class QueueController {
  constructor(private readonly queue: QueueService) {}

  /** Joins the queue (idempotent) and returns the buyer's current status. */
  @Post()
  join(@Param('eventId', uuidPipe) eventId: string, @UserId() userId: string) {
    return this.queue.join(eventId, userId);
  }

  @Get()
  status(@Param('eventId', uuidPipe) eventId: string, @UserId() userId: string) {
    return this.queue.status(eventId, userId);
  }
}
