// GET /api/v1/maestro/login is a top-level browser navigation: when the
// Maestro platform is down (OIDC discovery returns empty 200s — seen in the
// 2026-08-13 and 2026-08-17 outages), Better Auth answers with a 400 Response
// and the route used to 502, which Cloudflare replaces with its own "Host
// Error" page. These tests pin the friendly behavior: every failure mode
// redirects back to the SPA login screen with #maestro_error=unavailable,
// while the success path still 302s to Maestro with the PKCE cookie attached.
// DB-free: signInWithOAuth2 is stubbed, nothing touches Postgres.

import { afterAll, describe, expect, it, mock } from 'bun:test';

// Hermetic env so env.ts validates without an api/.env.
process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const APP_ORIGIN = 'https://app.respovia.com';
// Spread the whole real module so every export survives the mock — a partial
// stub would silently make the others undefined (see security-headers.test.ts).
const realEnvMod = await import('./lib/env.js');
mock.module('./lib/env.js', () => ({ ...realEnvMod, env: { ...realEnvMod.env, APP_BASE_URL: APP_ORIGIN } }));

// Swappable per test. Default: throw so a test that forgets to set it fails loudly.
let signInWithOAuth2: () => Promise<Response> = async () => {
  throw new Error('test forgot to stub signInWithOAuth2');
};

// maestroSignInEnabled is false in this env (no MAESTRO_CLIENT_ID/SECRET), so
// force it on; otherwise ensureEnabled() short-circuits before the stub runs.
const realAuthMod = await import('./lib/auth.js');
mock.module('./lib/auth.js', () => ({
  ...realAuthMod,
  maestroSignInEnabled: true,
  auth: {
    ...realAuthMod.auth,
    api: {
      ...realAuthMod.auth.api,
      signInWithOAuth2: (...args: unknown[]) => signInWithOAuth2(...(args as [])),
    },
  },
}));

const app = (await import('./index.js')).default;

afterAll(() => mock.restore());

const UNAVAILABLE_REDIRECT = `${APP_ORIGIN}/#maestro_error=unavailable`;

describe('GET /api/v1/maestro/login', () => {
  it('redirects to the SPA with maestro_error=unavailable when Better Auth returns no authorize URL (Maestro outage)', async () => {
    // The outage signature: discovery empty → Better Auth 400s with no `url`.
    signInWithOAuth2 = async () => new Response('{}', { status: 400 });
    const res = await app.request('/api/v1/maestro/login');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(UNAVAILABLE_REDIRECT);
  });

  it('redirects to the SPA with maestro_error=unavailable when signInWithOAuth2 throws', async () => {
    signInWithOAuth2 = async () => {
      throw new Error('boom');
    };
    const res = await app.request('/api/v1/maestro/login');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(UNAVAILABLE_REDIRECT);
  });

  it('still 302s to the Maestro authorize URL with the PKCE Set-Cookie propagated on success', async () => {
    const authorizeUrl = 'https://auth.mert.md/oauth2/authorize?client_id=x&state=y';
    const pkceCookie = 'better-auth.state=abc123; Path=/; HttpOnly; SameSite=Lax';
    signInWithOAuth2 = async () =>
      new Response(JSON.stringify({ url: authorizeUrl }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': pkceCookie },
      });
    const res = await app.request('/api/v1/maestro/login');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(authorizeUrl);
    expect(res.headers.getSetCookie()).toContain(pkceCookie);
  });
});
