import { expect, test } from 'bun:test';
import { scrubEvent } from './instrument.js';

test('Sentry rebuilds events from safe fields, dropping nested and future PII fields', () => {
  const secret = 'private-person@example.test_secret-token_passport.pdf';
  const event: any = {
    event_id: 'a'.repeat(32), timestamp: 12345,
    exception: { values: [{ type: 'TypeError', value: secret, stacktrace: { frames: [{ filename: secret, vars: { secret } }] } }, { type: secret, value: secret }] },
    request: { url: secret, query_string: secret, data: secret, cookies: secret, headers: { AUTHORIZATION: secret, 'x-custom': secret } },
    user: { email: secret, ip_address: secret }, breadcrumbs: [{ message: secret, data: { secret } }],
    extra: { code: '23505', status: 503, secret }, contexts: { secret }, tags: { secret },
    message: secret, logentry: { message: secret }, transaction: secret, server_name: secret,
    fingerprint: [secret], future_sdk_field: { secret },
  };
  const out = scrubEvent(event);
  expect(JSON.stringify(out)).not.toContain(secret);
  expect(out.event_id).toBe('a'.repeat(32));
  expect(out.extra).toEqual({ kind: 'api-error', code: '23505', status: 503 });
  expect(out.exception?.values?.map(e => e.type)).toEqual(['TypeError', 'Error']);
  expect(out.request).toBeUndefined();
  expect(out.breadcrumbs).toBeUndefined();
  expect(scrubEvent({ type: undefined })).toBeDefined();
});
