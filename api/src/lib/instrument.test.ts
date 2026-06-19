// Proves the Sentry PII scrubber strips request bodies, secrets and user
// identifiers before an event leaves the process — the GDPR backstop that
// keeps Sentry from becoming a second store of player/customer data. Hermetic:
// scrubEvent is a pure function, so no DSN, init, or network is involved.

import { describe, expect, it } from 'bun:test';
import { scrubEvent } from './instrument.js';

describe('scrubEvent (Sentry PII scrubber)', () => {
  function eventWithPii(): any {
    return {
      exception: { values: [{ type: 'Error', value: 'boom' }] },
      request: {
        url: 'https://api/api/v1/tickets',
        method: 'POST',
        data: { body: 'customer says: my card is 4111 1111 1111 1111, email a@b.com' },
        cookies: { session: 'secret-cookie' },
        query_string: 'token=abc123&email=a@b.com',
        headers: {
          'authorization': 'Bearer secret-token',
          'Cookie': 'session=secret',
          'x-workspace-id': 'ws-123',
          'content-type': 'application/json',
        },
      },
      user: { id: 'u-1', email: 'agent@desk.test', ip_address: '1.2.3.4' },
    };
  }

  it('strips request body, cookies and query string', () => {
    const out: any = scrubEvent(eventWithPii());
    expect(out.request.data).toBeUndefined();
    expect(out.request.cookies).toBeUndefined();
    expect(out.request.query_string).toBeUndefined();
  });

  it('strips auth + cookie + workspace headers but keeps benign ones', () => {
    const out: any = scrubEvent(eventWithPii());
    expect(out.request.headers.authorization).toBeUndefined();
    expect(out.request.headers.Cookie).toBeUndefined();
    expect(out.request.headers['x-workspace-id']).toBeUndefined();
    // Non-sensitive headers are preserved (useful for debugging).
    expect(out.request.headers['content-type']).toBe('application/json');
  });

  it('drops the user object entirely', () => {
    const out: any = scrubEvent(eventWithPii());
    expect(out.user).toBeUndefined();
  });

  it('preserves the exception payload (we still report the error)', () => {
    const out: any = scrubEvent(eventWithPii());
    expect(out.exception.values[0].value).toBe('boom');
  });

  it('is safe on an event with no request', () => {
    const out: any = scrubEvent({ exception: { values: [] } } as any);
    expect(out).toBeDefined();
  });
});
