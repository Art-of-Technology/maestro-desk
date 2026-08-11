import { describe, expect, it } from 'bun:test';
import type { Context } from 'hono';
import { clientIp } from './lib/rate-limit.js';

// clientIp() decides the identity every per-IP limit keys on, so each trust
// mode gets pinned here. Contexts are hand-built: `env.incoming.socket` is the
// shape @hono/node-server's getConnInfo reads; omitting it models a runtime
// with no socket (bun test / Bun.serve), where getConnInfo throws and the
// TRUST_PROXY path must fail closed to the shared bucket.
function ctx(headers: Record<string, string>, remoteAddress?: string): Context {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    env: remoteAddress ? { incoming: { socket: { remoteAddress } } } : {},
    req: {
      raw: new Request('http://api.test/', { headers: lower }),
      header: (name: string) => lower[name.toLowerCase()],
    },
  } as unknown as Context;
}

describe('clientIp under TRUST_PROXY', () => {
  it('trusts the right-most XFF entry when the TCP peer is the private overlay (Traefik)', () => {
    const c = ctx({ 'x-forwarded-for': '198.51.100.7, 203.0.113.9' }, '172.18.0.5');
    expect(clientIp(c, true)).toBe('203.0.113.9');
  });

  it('handles a v4-mapped IPv6 overlay peer the same way', () => {
    const c = ctx({ 'x-forwarded-for': '198.51.100.7' }, '::ffff:10.0.1.3');
    expect(clientIp(c, true)).toBe('198.51.100.7');
  });

  it('keys a direct (public-peer) connection on the real TCP address, ignoring forged XFF', () => {
    const c = ctx({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, '203.0.113.50');
    expect(clientIp(c, true)).toBe('203.0.113.50');
  });

  it('never falls back to the client-suppliable x-real-ip header', () => {
    const c = ctx({ 'x-real-ip': '9.9.9.9' }, '172.18.0.5');
    expect(clientIp(c, true)).toBe('172.18.0.5');
  });

  it('uses the shared unknown bucket when there is no socket at all', () => {
    const c = ctx({ 'x-real-ip': '9.9.9.9' });
    expect(clientIp(c, true)).toBe('unknown');
  });
});

describe('clientIp without TRUST_PROXY (Vercel / dev)', () => {
  it("prefers Vercel's trusted header via ipAddress()", () => {
    const c = ctx({ 'x-real-ip': '203.0.113.77', 'x-forwarded-for': '1.2.3.4' });
    expect(clientIp(c, false)).toBe('203.0.113.77');
  });

  it('falls back to the left-most XFF entry in dev', () => {
    const c = ctx({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1' });
    expect(clientIp(c, false)).toBe('198.51.100.7');
  });

  it('shares the unknown bucket with no attributable headers', () => {
    expect(clientIp(ctx({}), false)).toBe('unknown');
  });
});
