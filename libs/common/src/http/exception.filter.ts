import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from './api-error.js';

export interface ErrorBody {
  error: { code: string; message: string; requestId: string; details?: unknown };
}

/**
 * Every error leaves the API in one shape, and unexpected errors never leak
 * internals to clients: they get a generic 500 with a request id that points
 * at the full stack trace in the logs.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<FastifyRequest>();
    const reply = ctx.getResponse<FastifyReply>();
    const requestId = String(req.id);

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      // ApiError carries its own code and details. For framework exceptions,
      // validation errors put per-field messages in `message`; surface those,
      // but don't echo a plain message that is already in `message`.
      const details =
        exception instanceof ApiError
          ? exception.details
          : typeof response === 'object' && response !== null && 'message' in response
            ? response.message
            : undefined;
      const body: ErrorBody = {
        error: {
          code: exception instanceof ApiError ? exception.code : statusCode(status),
          message: exception.message,
          requestId,
          ...(details !== undefined && details !== exception.message ? { details } : {}),
        },
      };
      // 503 is deliberate (draining, load shedding) and can be thousands per
      // second during a spike; it is counted in metrics, not logged per request.
      if (status >= 500 && status !== Number(HttpStatus.SERVICE_UNAVAILABLE)) {
        this.logger.error({ err: exception, requestId }, exception.message);
      }
      return reply.status(status).send(body);
    }

    this.logger.error({ err: exception, requestId }, 'Unhandled exception');
    const body: ErrorBody = {
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId },
    };
    return reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send(body);
  }
}

function statusCode(status: number): string {
  return HttpStatus[status] ?? `HTTP_${status}`;
}
