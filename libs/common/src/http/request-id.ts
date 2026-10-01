import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const MAX_LENGTH = 128;
const SAFE = /^[\w.:-]+$/;

/**
 * Reuses the caller's X-Request-Id (Nginx sets one on every request) so one id
 * follows a request across the proxy, services and logs. Untrusted values that
 * are too long or contain unexpected characters are replaced, so a client
 * cannot inject junk into log lines.
 */
export function requestIdFor(req: IncomingMessage): string {
  const incoming = req.headers['x-request-id'];
  return typeof incoming === 'string' && incoming.length <= MAX_LENGTH && SAFE.test(incoming)
    ? incoming
    : randomUUID();
}
