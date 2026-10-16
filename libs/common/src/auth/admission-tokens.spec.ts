import { SignJWT } from 'jose';
import { AdmissionTokens } from './admission-tokens.js';

const SECRET = 'test-secret-that-is-at-least-32-characters';
const admission = { userId: '0b5f6a1e-7c38-4d1a-9a4e-2f0c1d3b5e7a', eventId: 'event-1' };

describe('AdmissionTokens', () => {
  const tokens = new AdmissionTokens(SECRET);

  it('round-trips a valid token', async () => {
    const { token, expiresAt } = await tokens.sign(admission, 60);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await tokens.verify(token)).toEqual({ ok: true, admission });
  });

  it('rejects an expired token as expired', async () => {
    const { token } = await tokens.sign(admission, -60);
    expect(await tokens.verify(token)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a token signed with another secret', async () => {
    const forged = new AdmissionTokens('a-completely-different-secret-of-32-chars');
    const { token } = await forged.sign(admission, 60);
    expect(await tokens.verify(token)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a tampered token', async () => {
    const { token } = await tokens.sign(admission, 60);
    const [header, payload, signature] = token.split('.');
    const evil = Buffer.from(JSON.stringify({ sub: admission.userId, eventId: 'other' })).toString(
      'base64url',
    );
    expect(payload).not.toBe(evil);
    expect(await tokens.verify(`${header}.${evil}.${signature}`)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('rejects a correctly signed token meant for another audience', async () => {
    const token = await new SignJWT({ eventId: admission.eventId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(admission.userId)
      .setIssuer('surge-waiting-room')
      .setAudience('some-other-service')
      .setExpirationTime('1m')
      .sign(new TextEncoder().encode(SECRET));
    expect(await tokens.verify(token)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects garbage', async () => {
    expect(await tokens.verify('not-a-jwt')).toEqual({ ok: false, reason: 'invalid' });
  });
});
