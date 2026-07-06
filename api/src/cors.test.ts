// Tests for the CORS policy in index.ts. The authenticated agent API + auth
// routes are locked to APP_BASE_URL + localhost dev; on PREVIEW deployments
// only (isVercelPreview), team PR-preview SPA origins are also reflected so
// features are verifiable from a preview link (they target the staging API).
// The public/portal API (/api/v1/public/*) stays open so white-label portals
// on arbitrary verified custom domains can call it.
//
// We drive the policy through OPTIONS preflights (handled by the cors
// middleware directly, so no route handler / DB is touched) plus one real GET
// against the DB-free health route.

import { describe, expect, it, mock, afterAll, beforeEach, afterEach } from 'bun:test';

// Hermetic env so env.ts validates without an api/.env.
process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

// Pin APP_BASE_URL to a prod-like origin so allow/deny are distinguishable.
// Spread the real module (env may already be cached from another test file) so
// the stub keeps every export (isLocalDev, isVercelPreview, …), then override.
// Mock before importing index.ts. index.ts reads isVercelPreview at request
// time, so setPreview() below can flip it per-test via mock.module.
const APP_ORIGIN = 'https://desk.maestro-desk.com';
// A team PR-preview SPA origin: git-BRANCH deploy under the team namespace.
const PREVIEW_ORIGIN = 'https://maestro-desk-git-feat-x-abc12-jodi-1420s-projects.vercel.app';
const realEnvMod = await import('./lib/env.js');
const stubEnv = { ...realEnvMod.env, APP_BASE_URL: APP_ORIGIN };
function setPreview(flag: boolean) {
  mock.module('./lib/env.js', () => ({ ...realEnvMod, env: stubEnv, isVercelPreview: flag }));
}
setPreview(false);

const app = (await import('./index.js')).default;

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

  it('denies a *.vercel.app origin outside the team namespace', async () => {
    const res = await preflight('/api/v1/tickets', 'https://maestro-desk-git-feature.vercel.app');
    expect(acao(res)).toBeNull();
  });

  it('denies a team PR-preview origin on non-preview deployments', async () => {
    const res = await preflight('/api/v1/tickets', PREVIEW_ORIGIN);
    expect(acao(res)).toBeNull();
  });

  it('denies an unknown origin (no Allow-Origin header)', async () => {
    const res = await preflight('/api/v1/tickets', 'https://evil.example.com');
    expect(acao(res)).toBeNull();
  });
});

// PR-preview SPA origins are reflected ONLY on preview deployments
// (isVercelPreview), where api-base.js points them at the staging API.
describe('CORS — preview deployments (isVercelPreview)', () => {
  beforeEach(() => setPreview(true));
  afterEach(() => setPreview(false));

  it('reflects a team PR-preview origin', async () => {
    const res = await preflight('/api/v1/tickets', PREVIEW_ORIGIN);
    expect(res.status).toBe(204);
    expect(acao(res)).toBe(PREVIEW_ORIGIN);
  });

  it('still denies lookalike origins (anchored regex)', async () => {
    // Suffix attack: the team hostname as a subdomain of an attacker domain.
    let res = await preflight('/api/v1/tickets', `${PREVIEW_ORIGIN}.attacker.com`);
    expect(acao(res)).toBeNull();
    // Outside the team namespace entirely.
    res = await preflight('/api/v1/tickets', 'https://maestro-desk-git-feature.vercel.app');
    expect(acao(res)).toBeNull();
  });

  // Production deployment URLs share the team suffix but must NOT match — the
  // pattern requires a `git-<branch>` marker and excludes `git-main`, so prod's
  // hash deployment URL and its main-branch alias both stay denied even here.
  it('denies production deployment URLs (hash + git-main alias)', async () => {
    let res = await preflight('/api/v1/tickets', 'https://maestro-desk-abc123-jodi-1420s-projects.vercel.app');
    expect(acao(res)).toBeNull();
    res = await preflight('/api/v1/tickets', 'https://maestro-desk-git-main-jodi-1420s-projects.vercel.app');
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

  // Regression: an encoded-slash traversal keeps the literal /api/v1/public/
  // prefix but must NOT get the open policy — it falls to the locked branch, so
  // an unknown origin is denied. (Guards against the path-prefix bypass.)
  it('does not open up an encoded-slash traversal path', async () => {
    const res = await preflight('/api/v1/public/..%2Ftickets', 'https://evil.example.com');
    expect(acao(res)).toBeNull();
  });
});
