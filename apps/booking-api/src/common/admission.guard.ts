import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { type Admission, AdmissionTokens, ApiError } from '@surge/common';
import type { FastifyRequest } from 'fastify';

export const ADMISSION_TOKENS = Symbol('ADMISSION_TOKENS');

type AdmittedRequest = FastifyRequest & { admission?: Admission };

/**
 * Only buyers the waiting room has let through may hold seats or check out.
 * The token is verified locally (no network hop) and must be for the event
 * in the URL, so admission to one sale cannot be used to skip the queue of
 * another.
 */
@Injectable()
export class AdmissionGuard implements CanActivate {
  constructor(@Inject(ADMISSION_TOKENS) private readonly tokens: AdmissionTokens) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AdmittedRequest>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new ApiError(HttpStatus.UNAUTHORIZED, 'ADMISSION_REQUIRED', 'Join the queue first');
    }

    const result = await this.tokens.verify(token);
    if (!result.ok) {
      throw result.reason === 'expired'
        ? new ApiError(HttpStatus.UNAUTHORIZED, 'ADMISSION_EXPIRED', 'Admission has expired')
        : new ApiError(HttpStatus.UNAUTHORIZED, 'ADMISSION_INVALID', 'Invalid admission token');
    }

    const { eventId } = req.params as { eventId?: string };
    if (eventId !== undefined && eventId !== result.admission.eventId) {
      throw new ApiError(
        HttpStatus.FORBIDDEN,
        'ADMISSION_WRONG_EVENT',
        'Admission is for a different event',
      );
    }

    req.admission = result.admission;
    return true;
  }
}

/** The admission verified by AdmissionGuard for this request. */
export const Admitted = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const admission = ctx.switchToHttp().getRequest<AdmittedRequest>().admission;
  if (!admission) throw new Error('@Admitted() used on a route without AdmissionGuard');
  return admission;
});
