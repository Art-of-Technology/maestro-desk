// maestroFetch's response contract. The Maestro platform moved domains in
// 2026-08 and the RETIRED hosts kept answering — 200 with a zero-byte body on
// every path, including OIDC discovery — which is why the outage read as
// "temporarily unavailable" for six days instead of "wrong host". A gateway
// client that treats those bodies as data turns that into silent corruption:
// callers read `.organizations` off a string or a null and conclude the agent
// has no brand access. These tests pin the loud failure instead.
// DB-free: global fetch is stubbed, nothing touches Postgres or the network.

import { afterEach, describe, expect, it } from 'bun:test';
import { maestroFetch, MaestroError } from './lib/maestro.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub the next fetch with a canned response. */
function stubFetch(body: string, init: ResponseInit & { contentType?: string } = {}) {
  const { contentType = 'application/json', ...rest } = init;
  // Cast through unknown: the stub only needs to be callable, not to carry
  // fetch's static members (preconnect).
  globalThis.fetch = (async () =>
    new Response(body === '' ? null : body, {
      status: 200,
      ...rest,
      headers: { 'content-type': contentType },
    })) as unknown as typeof fetch;
}

describe('maestroFetch response contract', () => {
  it('parses a normal JSON 2xx body', async () => {
    stubFetch(JSON.stringify({ organizations: [{ id: 'o1' }] }));
    const data = await maestroFetch<{ organizations: { id: string }[] }>('/api/v1/organizations', {
      token: 't',
    });
    expect(data.organizations[0].id).toBe('o1');
  });

  it('rejects an EMPTY 2xx body — the retired-host signature — instead of returning null', async () => {
    // Exactly what auth.mert.md / api.mert.md served on every path post-migration.
    stubFetch('');
    let err: unknown;
    try {
      await maestroFetch('/api/v1/organizations', { token: 't' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MaestroError);
    expect((err as MaestroError).status).toBe(502);
    expect((err as MaestroError).message).toContain('EMPTY');
  });

  it('rejects a non-JSON 2xx body (parked page / proxy interstitial)', async () => {
    stubFetch('<html><body>Parked domain</body></html>', { contentType: 'text/html' });
    let err: unknown;
    try {
      await maestroFetch('/api/v1/organizations', { token: 't' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MaestroError);
    expect((err as MaestroError).status).toBe(502);
    expect((err as MaestroError).message).toContain('non-JSON');
  });

  it('still allows a deliberate 204 no-content success', async () => {
    stubFetch('', { status: 204 });
    // A 204 is a real success, so the empty-body guard must NOT fire. There is
    // no body to parse, so callers get null rather than a throw.
    await expect(maestroFetch('/api/v1/thing', { token: 't', method: 'DELETE' })).resolves.toBeNull();
  });

  it('surfaces the orchestrator error envelope on a non-2xx', async () => {
    stubFetch(JSON.stringify({ error: 'Invalid or expired access token', code: 'UNAUTHORIZED' }), {
      status: 401,
    });
    let err: unknown;
    try {
      await maestroFetch('/api/v1/users/me', { token: 'bogus' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MaestroError);
    expect((err as MaestroError).status).toBe(401);
    expect((err as MaestroError).message).toBe('Invalid or expired access token');
  });
});
