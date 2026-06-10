// Tests for the CORS policy in index.ts. The authenticated agent API + auth
// routes are locked to APP_BASE_URL + localhost dev + *.vercel.app previews;
// the public/portal API (/api/v1/public/*) stays open so white-label portals
// on arbitrary verified custom domains can call it.
//
// We drive the policy through OPTIONS preflights (handled by the cors
// middleware directly, so no route handler / DB is touched) plus one real GET
// against the DB-free health route.

import { describe, expect, it, mock, afterAll } from 'bun:test';

// Hermetic env so env.ts validates without an api/.env.
process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

// Pin APP_BASE_URL to a prod-like origin so allow/deny are distinguishable.
// Spread the real parsed env so the stub is complete (env may already be cached
// from another test file), then override. Mock before importing index.ts.
const APP_ORIGIN = 'https://desk.maestro-desk.com';
const { env: realEnv } = await import('./lib/env.ts');
mock.module('./lib/env.ts', () => ({ env: { ...realEnv, APP_BASE_URL: APP_ORIGIN } }));

const app = (await import('./index.ts')).default;

afterAll(() => mock.restore());

// Preflight helper: an OPTIONS request the cors middleware answers directly.
function preflight(path: string, origin: string) {
  return app.request(path, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
  });
}
const acao = (res: Response) => res.headers.get('access-control-allow-origin');

describe('CORS — authenticated agent API', () => {
  it('reflects the agent SPA origin on a real GET', async () => {
    const res = await app.request('/api/v1/health', { headers: { Origin: APP_ORIGIN } });
    expect(res.status).toBe(200);
    expect(acao(res)).toBe(APP_ORIGIN);
  });

  it('allows the agent SPA origin (preflight)', async () => {
    const res = await preflight('/api/v1/tickets', APP_ORIGIN);
    expect(res.status).toBe(204);
    expect(acao(res)).toBe(APP_ORIGIN);
  });

  it('allows a *.vercel.app preview origin', async () => {
    const origin = 'https://maestro-desk-git-feature.vercel.app';
    const res = await preflight('/api/v1/tickets', origin);
    expect(acao(res)).toBe(origin);
  });

  it('denies an unknown origin (no Allow-Origin header)', async () => {
    const res = await preflight('/api/v1/tickets', 'https://evil.example.com');
    expect(acao(res)).toBeNull();
  });
});

describe('CORS — public/portal API stays open', () => {
  it('reflects an arbitrary brand custom-domain origin', async () => {
    const origin = 'https://help.acme.com';
    const res = await preflight('/api/v1/public/resolve-host', origin);
    expect(res.status).toBe(204);
    expect(acao(res)).toBe(origin);
  });
});
