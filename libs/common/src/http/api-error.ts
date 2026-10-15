import { HttpException } from '@nestjs/common';

/**
 * An expected, client-facing failure with a stable machine-readable code
 * (e.g. SEATS_UNAVAILABLE) that clients can branch on, unlike HTTP status
 * names which are shared by many different failures.
 */
export class ApiError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}
