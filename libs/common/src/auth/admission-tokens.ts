import { errors, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

const ISSUER = 'surge-waiting-room';
const AUDIENCE = 'surge-booking';

export const admissionConfigSchema = z.object({
  // Shared by the waiting room (signs) and booking API (verifies).
  ADMISSION_TOKEN_SECRET: z.string().min(32, 'must be at least 32 characters'),
});

export interface Admission {
  userId: string;
  eventId: string;
}

export type VerifyResult =
  { ok: true; admission: Admission } | { ok: false; reason: 'expired' | 'invalid' };

/**
 * Signed, short-lived proof that the waiting room let a user through for one
 * event. The booking API verifies it locally with no network call, so this
 * check costs microseconds even at peak traffic.
 */
export class AdmissionTokens {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  async sign(
    admission: Admission,
    ttlSeconds: number,
  ): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1_000);
    const token = await new SignJWT({ eventId: admission.eventId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(admission.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1_000))
      .sign(this.key);
    return { token, expiresAt };
  }

  async verify(token: string): Promise<VerifyResult> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
        clockTolerance: 5,
      });
      if (typeof payload.sub !== 'string' || typeof payload.eventId !== 'string') {
        return { ok: false, reason: 'invalid' };
      }
      return { ok: true, admission: { userId: payload.sub, eventId: payload.eventId } };
    } catch (err) {
      return { ok: false, reason: err instanceof errors.JWTExpired ? 'expired' : 'invalid' };
    }
  }
}
