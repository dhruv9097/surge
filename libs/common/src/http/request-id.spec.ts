import type { IncomingMessage } from 'node:http';
import { requestIdFor } from './request-id.js';

const req = (id?: string) =>
  ({ headers: id === undefined ? {} : { 'x-request-id': id } }) as IncomingMessage;
const UUID = /^[0-9a-f-]{36}$/;

describe('requestIdFor', () => {
  it('reuses a well-formed incoming id', () => {
    expect(requestIdFor(req('5c30ce96b9fc2b8be349b87e527688b2'))).toBe(
      '5c30ce96b9fc2b8be349b87e527688b2',
    );
  });

  it('generates a uuid when the header is missing', () => {
    expect(requestIdFor(req())).toMatch(UUID);
  });

  it.each([['a'.repeat(129)], ['has spaces'], ['line\nbreak'], ['<script>']])(
    'replaces untrusted value %j',
    (value) => {
      expect(requestIdFor(req(value))).toMatch(UUID);
    },
  );
});
