// The Maestro sign-in flow is top-level browser navigation: when the Maestro
// platform is down (OIDC discovery returns empty 200s — seen in the 2026-08-13
// and 2026-08-17 outages), Better Auth answers with a 400 Response and
// GET /api/v1/maestro/login used to 502, which Cloudflare replaces with its
// own "Host Error" page. These tests pin the friendly behavior: failures
// redirect back to the SPA login screen with a #maestro_error code, deliberate
// HTTP errors keep their status, and the success path still 302s to Maestro
// with the PKCE cookie attached. DB-free: auth.api calls are stubbed, nothing
// touches Postgres. Hermetic env comes from the bunfig preload (test-setup.ts),
// including the APP_BASE_URL pin — don't re-set it here.

import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import { HTTPException } from 'hono/http-exception';

// maestroSignInEnabled is false in this env (no MAESTRO_CLIENT_ID/SECRET), so
// force it on; otherwise ensureEnabled() short-circuits before the stubs run.
// Spread the whole real module so every export survives the mock — a partial
// stub would silently make the others undefined (see security-headers.test.ts).
// CRITICAL: the `auth` object passes through UNTOUCHED (by reference via the
// spread). index.js gets module-cached with whatever auth object is live here,
// and all test files share that cache — an earlier version that spread a COPY
// of auth/api broke every DB-backed file that ran afterwards. The two methods
// under test are patched in place on the real object and restored after each
// test instead.
const realAuthMod = await import('./lib/auth.js');
mock.module('./lib/auth.js', () => ({ ...realAuthMod, maestroSignInEnabled: true }));

const api = realAuthMod.auth.api as unknown as Record<string, (...args: unknown[]) => unknown>;
const realSignInWithOAuth2 = api.signInWithOAuth2;
const realGetSession = api.getSession;

const { env } = await import('./lib/env.js');
const app = (await import('./index.js')).default;

// Restore the real methods after EVERY test so no stub can outlive this file
// via the cached app (CI's DB-backed suites caught exactly that: a lingering
// getSession throw 500'd the SLA report test).
afterEach(() => {
  api.signInWithOAuth2 = realSignInWithOAuth2;
  api.getSession = realGetSession;
});

// bun's mock.restore() does NOT undo mock.module, and all test files share one
// module registry — re-mock the real module back so files that load after this
// one don't inherit maestroSignInEnabled=true.
afterAll(() => {
  api.signInWithOAuth2 = realSignInWithOAuth2;
  api.getSession = realGetSession;
  mock.module('./lib/auth.js', () => ({ ...realAuthMod }));
  mock.restore();
});

const UNAVAILABLE_REDIRECT = `${env.APP_BASE_URL}/#maestro_error=unavailable`;
const SIGNIN_FAILED_REDIRECT = `${env.APP_BASE_URL}/#maestro_error=signin_failed`;

describe('GET /api/v1/maestro/login', () => {
  it('redirects to the SPA with maestro_error=unavailable when Better Auth returns no authorize URL (Maestro outage)', async () => {
    // The outage signature: discovery empty → Better Auth 400s with no `url`.
    api.signInWithOAuth2 = async () => new Response('{}', { status: 400 });
    const res = await app.request('/api/v1/maestro/login');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(UNAVAILABLE_REDIRECT);
  });

  it('redirects to the SPA with maestro_error=unavailable when signInWithOAuth2 throws', async () => {
    api.signInWithOAuth2 = async () => {
      throw new Error('boom');
    };
    const res = await app.request('/api/v1/maestro/login');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(UNAVAILABLE_REDIRECT);
  });

  it('lets deliberate HTTP errors keep their status (a config 503 is not "try again in a few minutes")', async () => {
    api.signInWithOAuth2 = async () => {
      throw new HTTPException(503, { message: 'Sign in with Maestro is not configured on this server.' });
    };
    const res = await app.request('/api/v1/maestro/login');
    expect(res.status).toBe(503);
  });

  it('still 302s to the Maestro authorize URL with the PKCE Set-Cookie propagated on success', async () => {
    const authorizeUrl = 'https://auth.mert.md/oauth2/authorize?client_id=x&state=y';
    const pkceCookie = 'better-auth.state=abc123; Path=/; HttpOnly; SameSite=Lax';
    api.signInWithOAuth2 = async () =>
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

describe('GET /api/v1/maestro/oauth-error', () => {
  it('redirects the Better Auth mid-dance failure back to the SPA login screen', async () => {
    const res = await app.request('/api/v1/maestro/oauth-error?error=access_denied');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(SIGNIN_FAILED_REDIRECT);
  });
});

describe('GET /api/v1/maestro/oauth-complete', () => {
  it('redirects with maestro_error=signin_failed instead of a raw 500 when getSession throws', async () => {
    api.getSession = async () => {
      throw new Error('db blip');
    };
    const res = await app.request('/api/v1/maestro/oauth-complete');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(SIGNIN_FAILED_REDIRECT);
  });
});
