// Rate-limiting for the better-auth surface (lib/auth-rate-limit.ts + index.ts).
// DB-backed (the limiter uses check_rate_limit in Neon), so gated behind
// RUN_DB_TESTS like the isolation suite. We drive the real Hono app; each test
// uses a unique X-Forwarded-For (clientIp falls back to XFF when Vercel's
// ipAddress() is absent) and a unique email so buckets never collide.
//
//   RUN_DB_TESTS=1 DATABASE_URL='…?sslmode=disable' bun test src/auth-rate-limit.test.ts

import { beforeAll, describe, expect, it } from 'bun:test';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('auth rate limiting (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  const RUN = Date.now();
  // Per-IP buckets persist in the DB for the whole window, so they must not
  // collide across runs (a stale bucket could pre-trip the control test).
  // A random 16-bit base per process (octets 2-3) + a per-test counter (octet
  // 4) gives every test a unique, collision-resistant IP.
  const IP_BASE = Math.floor(Math.random() * 0x10000);
  let ipSeq = 0;
  const freshIp = () => `10.${(IP_BASE >> 8) & 0xff}.${IP_BASE & 0xff}.${(ipSeq += 1)}`;

  function post(path: string, body: unknown, ip: string) {
    return app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    // Fail with a clear message (not a confusing 429-vs-401 assertion) if the
    // DB / migration isn't there: enforceRateLimit fails OPEN on a DB error, so
    // without this the throttle assertions would just silently never see a 429.
    const sql = (await import('./lib/db.js')).getDb();
    try {
      const [row] = await sql<{ ok: boolean }[]>`select exists(select 1 from pg_proc where proname = 'check_rate_limit') as ok`;
      if (!row?.ok) throw new Error("check_rate_limit() missing — run `bun scripts/migrate.ts` before RUN_DB_TESTS");
    } catch (e) {
      throw new Error(`auth-rate-limit.test needs a reachable, migrated DB: ${e instanceof Error ? e.message : e}`);
    }
  });

  it('throttles repeated failed logins (401s then 429)', async () => {
    const ip = freshIp();
    const email = `login-${RUN}@t.test`;
    const body = { email, password: 'wrong-password-123' };
    // Email bucket is 10/10min and IP bucket 20/10min — 21 attempts exhausts
    // both; early attempts are 401 (bad creds), the over-limit one is 429.
    let final: Response | null = null;
    for (let i = 0; i < 21; i++) final = await post('/api/auth/sign-in/email', body, ip);
    expect(final!.status).toBe(429);
    expect(final!.headers.get('Retry-After')).toBeTruthy();
    // A further attempt from the same ip/email is still blocked (window open).
    const again = await post('/api/auth/sign-in/email', body, ip);
    expect(again.status).toBe(429);
  });

  it('throttles password-reset requests (reset-bomb protection)', async () => {
    const ip = freshIp();
    const email = `reset-${RUN}@t.test`;
    // request-password-reset IP bucket is 5/15min.
    let final: Response | null = null;
    for (let i = 0; i < 6; i++) final = await post('/api/auth/request-password-reset', { email, redirectTo: '/' }, ip);
    expect(final!.status).toBe(429);
  });

  it('does not block a normal single login attempt (401, not 429)', async () => {
    const ip = freshIp();
    const res = await post('/api/auth/sign-in/email', { email: `solo-${RUN}@t.test`, password: 'nope-123456' }, ip);
    expect(res.status).not.toBe(429);
    expect(res.status).toBeGreaterThanOrEqual(400); // invalid creds → 4xx (typically 401)
    expect(res.status).toBeLessThan(500);
  });

  it('does not rate-limit GET /get-session (pass-through)', async () => {
    const ip = freshIp();
    let last: Response | null = null;
    for (let i = 0; i < 25; i++) {
      last = await app.request('/api/auth/get-session', { headers: { 'X-Forwarded-For': ip } });
    }
    expect(last!.status).not.toBe(429);
  });
});
