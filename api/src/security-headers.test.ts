// Tests for the global security headers (advisory #8) and that they do NOT
// regress the deliberately CORS-open white-label portal API. DB-free: we hit
// the health route (no DB) and an OPTIONS preflight (handled by middleware).

import { afterAll, describe, expect, it, mock } from 'bun:test';

// Hermetic env so env.ts validates without an api/.env.
process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const APP_ORIGIN = 'https://desk.maestro-desk.com';
const { env: realEnv } = await import('./lib/env.js');
mock.module('./lib/env.js', () => ({ env: { ...realEnv, APP_BASE_URL: APP_ORIGIN } }));
const app = (await import('./index.js')).default;

afterAll(() => mock.restore());

describe('security headers', () => {
  it('sets nosniff, frame-deny, HSTS, and a tight CSP on a normal response', async () => {
    const res = await app.request('/api/v1/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('does NOT set cross-origin isolation headers (would constrain the open portal)', async () => {
    const res = await app.request('/api/v1/health');
    expect(res.headers.get('cross-origin-resource-policy')).toBeNull();
    expect(res.headers.get('cross-origin-embedder-policy')).toBeNull();
    // COOP defaults ON in hono — pin it absent too, as it's the one most
    // likely to be silently re-enabled by a future refactor.
    expect(res.headers.get('cross-origin-opener-policy')).toBeNull();
  });

  it('still reflects the origin for the public portal API (CORS not regressed)', async () => {
    const portalOrigin = 'https://brand.example.com';
    const res = await app.request('/api/v1/public/anything', {
      method: 'OPTIONS',
      headers: {
        origin: portalOrigin,
        'access-control-request-method': 'GET',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe(portalOrigin);
    // Credentials must NEVER be combined with a reflected origin.
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });
});
