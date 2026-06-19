// Tests for the Vercel Cron endpoints (routes/cron.ts): the CRON_SECRET bearer
// guard, and that an authorized call runs the corresponding sweep. The sweep
// functions touch the DB, so they're stubbed; env is stubbed to a known
// CRON_SECRET so the guard is deterministic regardless of the ambient .env or
// test-run order.

import { describe, expect, it, mock, afterAll } from 'bun:test';

// Hermetic env so the real env.ts (pulled in below to derive a complete stub)
// validates without an api/.env. The DB URL is a placeholder — connections are
// lazy, so nothing opens a socket here.
process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const CRON_SECRET = 'test-cron-secret';

// Spread the real parsed env so the stub has every field (env.ts may already be
// cached from another test file with CRON_SECRET=''), then force CRON_SECRET.
// Mocking env.ts before importing cron.ts makes the guard independent of how
// env was first parsed. A complete stub also means the override is harmless if
// it leaks to a later file.
const { env: realEnv } = await import('../lib/env.js');
mock.module('../lib/env.js', () => ({ env: { ...realEnv, CRON_SECRET } }));

// Stub the sweeps so the handlers return without hitting the DB.
mock.module('../lib/outgoing-webhooks.js', () => ({
  processPendingDeliveries: async () => ({ processed: 3 }),
}));

const { cron } = await import('./cron.js');

afterAll(() => mock.restore());

describe('cron endpoints — CRON_SECRET guard', () => {
  it('rejects a request with no Authorization header (401)', async () => {
    const res = await cron.request('/webhook-retry');
    expect(res.status).toBe(401);
  });

  it('rejects a request with the wrong bearer (401)', async () => {
    const res = await cron.request('/webhook-retry', {
      headers: { Authorization: 'Bearer wrong-secret' },
    });
    expect(res.status).toBe(401);
  });

  it('runs the webhook-retry sweep with the correct bearer (200)', async () => {
    const res = await cron.request('/webhook-retry', {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, processed: 3 });
  });
});
