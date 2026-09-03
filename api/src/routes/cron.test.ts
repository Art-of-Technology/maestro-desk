// Tests for the Vercel Cron endpoints (routes/cron.ts): the CRON_SECRET bearer
// guard, and that an authorized call runs the corresponding sweep. The sweep
// functions touch the DB, so they're stubbed; env is stubbed to a known
// CRON_SECRET so the guard is deterministic regardless of the ambient .env or
// test-run order.

import { describe, expect, it, mock, afterAll, beforeEach } from 'bun:test';

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
// env was first parsed. Spreading the full module keeps every export present so
// the override is harmless if it leaks to a later file.
const realEnvMod = await import('../lib/env.js');
mock.module('../lib/env.js', () => ({ ...realEnvMod, env: { ...realEnvMod.env, CRON_SECRET } }));

// Stub the sweeps so the handlers return without hitting the DB.
mock.module('../lib/outgoing-webhooks.js', () => ({
  processPendingDeliveries: async () => ({ processed: 3 }),
}));

// Audit-chain verify is swapped per-test (clean vs tampered); default = clean.
let auditResult: {
  checked: number;
  tampered: Array<{ workspaceId: string; firstBadSeq: number | null; firstBadId: string | null }>;
} = { checked: 2, tampered: [] };
mock.module('../lib/audit-verify.js', () => ({
  // Daily/retention path (incremental; accepts a {resetFirst} option) and the
  // standalone /audit-verify path (full, read-only) — both return the fixture.
  verifyAuditChains: async () => auditResult,
  verifyAuditChainsFull: async () => auditResult,
}));

// Player-identity backfill: swapped per-test between a normal result and the
// job's own abort error (dead token / consecutive gateway failures). The
// cron-jobs module is SPREAD so every other export stays real — a partial
// mock leaks to later test files in bun (the env mock above spreads for the
// same reason) — and alertCronFailure is stubbed so the abort test can't make
// a real Postmark call through lib/alert.ts when another file's env leaks in.
const realCronJobs = await import('../lib/cron-jobs.js');
const { BackfillAbortError, BackfillBusyError } = await import('../lib/player-identity.js');
const OK_RESULT = {
  workspaces: 1, attempted: 2, linked: 1, notFound: 1, mismatched: 0, noPlayerId: 0, skipped: 0, failed: 0, remaining: 0,
};
let backfillImpl: (opts?: { maxAttempts?: number }) => Promise<typeof OK_RESULT> = async () => OK_RESULT;
mock.module('../lib/cron-jobs.js', () => ({
  ...realCronJobs,
  alertCronFailure: async () => {},
  runPlayerIdentityBackfill: (opts?: { maxAttempts?: number }) => backfillImpl(opts),
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

  it('rejects audit-verify with no bearer (401)', async () => {
    const res = await cron.request('/audit-verify');
    expect(res.status).toBe(401);
  });

  it('runs audit-verify and reports a clean result (200)', async () => {
    auditResult = { checked: 2, tampered: [] };
    const res = await cron.request('/audit-verify', {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, checked: 2, tamperedCount: 0, tampered: [] });
  });

  it('surfaces tampered chains with ok:false in the audit-verify response (200)', async () => {
    const tampered = [{ workspaceId: 'ws-1', firstBadSeq: 5, firstBadId: 'row-5' }];
    auditResult = { checked: 3, tampered };
    const res = await cron.request('/audit-verify', {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(res.status).toBe(200); // the check ran successfully…
    // …but ok:false signals the audit is unhealthy (tamper detected).
    expect(await res.json()).toEqual({ ok: false, checked: 3, tamperedCount: 1, tampered });
  });
});

describe('cron endpoints — player-identity-backfill', () => {
  const auth = { headers: { Authorization: `Bearer ${CRON_SECRET}` } };
  beforeEach(() => { backfillImpl = async () => OK_RESULT; });

  it('rejects a request with no bearer (401)', async () => {
    const res = await cron.request('/player-identity-backfill');
    expect(res.status).toBe(401);
  });

  it('runs the backfill with the bounded default per-call limit and returns its counts (200)', async () => {
    let seen: number | undefined;
    backfillImpl = async (opts) => { seen = opts?.maxAttempts; return OK_RESULT; };
    const res = await cron.request('/player-identity-backfill', auth);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; limit: number; linked: number; remaining: number };
    expect(body.ok).toBe(true);
    expect(body.limit).toBe(100);
    expect(seen).toBe(100);
    expect(body.linked).toBe(1);
    expect(body.remaining).toBe(0);
  });

  it('clamps ?limit to the maximum and ignores garbage', async () => {
    const seen: (number | undefined)[] = [];
    backfillImpl = async (opts) => { seen.push(opts?.maxAttempts); return OK_RESULT; };
    expect((await cron.request('/player-identity-backfill?limit=5000', auth)).status).toBe(200);
    expect((await cron.request('/player-identity-backfill?limit=abc', auth)).status).toBe(200);
    expect((await cron.request('/player-identity-backfill?limit=-3', auth)).status).toBe(200);
    expect((await cron.request('/player-identity-backfill?limit=250', auth)).status).toBe(200);
    expect(seen).toEqual([500, 100, 100, 250]);
  });

  it("forwards the job's own abort message with its counts (500)", async () => {
    const partial = { ...OK_RESULT, attempted: 5, failed: 5, remaining: 12 };
    backfillImpl = async () => {
      throw new BackfillAbortError('player-identity backfill aborted after 5 consecutive gateway failures (check MAESTRO_API_TOKEN / brand installation)', partial, 'gateway_failures');
    };
    const res = await cron.request('/player-identity-backfill', auth);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: string; remaining: number };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/consecutive gateway failures/);
    expect(body.remaining).toBe(12);
  });

  it('reports an already-running backfill as 409', async () => {
    backfillImpl = async () => { throw new BackfillBusyError(); };
    const res = await cron.request('/player-identity-backfill', auth);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/already running/);
  });

  it('never leaks an unexpected error message (fixed string, 500)', async () => {
    backfillImpl = async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432'); };
    const res = await cron.request('/player-identity-backfill', auth);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'player-identity-backfill failed' });
  });
});
