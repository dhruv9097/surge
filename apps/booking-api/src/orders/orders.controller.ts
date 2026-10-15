import { Controller, Get, Headers, HttpStatus, Param, Post, Res } from '@nestjs/common';
import { ZodValidationPipe } from '@surge/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CurrentUser } from '../common/current-user.js';
import { OrdersService } from './orders.service.js';

const uuidPipe = new ZodValidationPipe(z.uuid());
// @Headers() does not run pipes, so the header is validated in the handler.
const idempotencyKeyPipe = new ZodValidationPipe(
  z
    .string({ error: 'Idempotency-Key header is required' })
    .regex(/^[\w-]{8,100}$/, 'Idempotency-Key must be 8-100 letters, digits, - or _'),
);

@Controller()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /**
   * 201 when this request created the order, 200 when it is a retry that
   * returns the order created earlier.
   */
  @Post('events/:eventId/holds/:holdId/checkout')
  async checkout(
    @Param('eventId', uuidPipe) eventId: string,
    @Param('holdId', uuidPipe) holdId: string,
    @Headers('idempotency-key') rawIdempotencyKey: unknown,
    @CurrentUser() userId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const idempotencyKey = idempotencyKeyPipe.transform(rawIdempotencyKey);
    const { order, created } = await this.orders.checkout(eventId, holdId, userId, idempotencyKey);
    void reply.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return order;
  }

  @Get('orders/:orderId')
  get(@Param('orderId', uuidPipe) orderId: string, @CurrentUser() userId: string) {
    return this.orders.getForUser(orderId, userId);
  }
}
