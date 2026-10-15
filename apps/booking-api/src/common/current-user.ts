import { createParamDecorator, ExecutionContext, HttpStatus } from '@nestjs/common';
import { ApiError } from '@surge/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

const userId = z.uuid();

/**
 * The buyer making the request. For now this is the X-User-Id header; the
 * waiting room (next milestone) replaces it with the user id inside a signed
 * admission token, without any change to the handlers that use it.
 */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();
  const parsed = userId.safeParse(req.headers['x-user-id']);
  if (!parsed.success) {
    throw new ApiError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', 'Missing or invalid user');
  }
  return parsed.data;
});
