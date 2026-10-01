import { expect, test, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { requestDiagnostic, requestLogger, safeError } from './diagnostics.js';

const PRIVATE = 'private-person@example.test_secret-token_passport.pdf';

test('diagnostics retain known codes and status, never free-form error properties', () => {
  const err = Object.assign(new TypeError(PRIVATE), { code: '23505', status: 503, detail: PRIVATE, cause: new Error(PRIVATE) });
  expect(safeError(err)).toEqual({ type: 'TypeError', code: '23505', status: 503 });
  const unexpected = Object.assign(new Error(PRIVATE), { constructor: { name: PRIVATE }, code: PRIVATE, status: PRIVATE });
  expect(JSON.stringify(safeError(unexpected))).not.toContain(PRIVATE);
  expect(safeError({ get code() { throw new Error(PRIVATE); } })).toEqual({ type: 'UnknownError', code: null });
});

test('request logs use registered patterns for nested, wildcard, rejected, missing and failing routes', async () => {
  const logs: unknown[][] = [];
  const spy = spyOn(console, 'log').mockImplementation((...args) => { logs.push(args); });
  try {
    const app = new Hono();
    app.use('*', requestLogger);
    app.use('/early/*', async c => c.text('denied', 401));
    const child = new Hono();
    child.get('/:id', c => c.text('ok'));
    child.get('/:id/fail', () => { throw new Error(PRIVATE); });
    app.route('/tickets', child);
    app.get('/auth/*', c => c.text('ok'));
    app.onError((err, c) => {
      console.log('[error]', requestDiagnostic(c), safeError(err));
      return c.text('failed', 500);
    });
    for (const path of [`/tickets/${PRIVATE}`, `/tickets/${PRIVATE}/fail`, `/auth/${PRIVATE}`, `/missing/${PRIVATE}`, `/early/${PRIVATE}`]) {
      await app.request(`${path}?token=${PRIVATE}`, { headers: { authorization: PRIVATE, cookie: PRIVATE } });
    }
    const output = JSON.stringify(logs);
    expect(output).not.toContain(PRIVATE);
    const requests = logs.filter(line => line[0] === '[http]').map(line => line[1] as any);
    expect(requests.map(r => r.route)).toEqual(['/tickets/:id', '/tickets/:id/fail', '/auth/*', 'unmatched', 'unmatched']);
    expect(requests.map(r => r.status)).toEqual([200, 500, 200, 404, 401]);
    expect(requests.every(r => Number.isFinite(r.durationMs))).toBe(true);
  } finally { spy.mockRestore(); }
});
