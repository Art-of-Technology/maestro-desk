// Unit tests for assertPostmarkAuth (lib/postmark.ts). Pure — no DB, no network.
// We pin POSTMARK_INBOUND_SECRET via a mocked env module and drive the function
// with a minimal fake Hono Context exposing only req.header / req.query.

import { describe, expect, it, mock } from 'bun:test';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

// Hermetic env so env.ts validates without an api/.env.
process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'unit-test-secret-0123456789';

const SECRET = 'unit-test-secret-0123456789';
const { env: realEnv } = await import('./lib/env.js');
mock.module('./lib/env.js', () => ({ env: { ...realEnv, POSTMARK_INBOUND_SECRET: SECRET } }));
const { assertPostmarkAuth } = await import('./lib/postmark.js');

function ctx({ auth, query }: { auth?: string; query?: string }): Context {
  return {
    req: {
      header: (k: string) => (k.toLowerCase() === 'authorization' ? auth : undefined),
      query: (k: string) => (k === 'secret' ? query : undefined),
    },
  } as unknown as Context;
}

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
const accepts = (c: Context) => expect(() => assertPostmarkAuth(c)).not.toThrow();
function rejects(c: Context) {
  try {
    assertPostmarkAuth(c);
  } catch (e) {
    expect(e).toBeInstanceOf(HTTPException);
    expect((e as HTTPException).status).toBe(401);
    return;
  }
  throw new Error('expected assertPostmarkAuth to throw 401');
}

describe('assertPostmarkAuth', () => {
  it('accepts a valid Bearer token', () => accepts(ctx({ auth: `Bearer ${SECRET}` })));
  it('accepts valid Basic auth (secret in password slot)', () => accepts(ctx({ auth: basic('postmark', SECRET) })));

  it('rejects when nothing is provided', () => rejects(ctx({})));
  it('rejects a wrong Bearer token', () => rejects(ctx({ auth: 'Bearer wrong-secret-000000' })));
  it('rejects a wrong Basic password', () => rejects(ctx({ auth: basic('postmark', 'wrong-secret-000000') })));

  // The URL ?secret= query is no longer accepted — the secret must ride in the
  // Authorization header, never the URL.
  it('rejects a ?secret= query, even with the correct value', () => rejects(ctx({ query: SECRET })));

  it('rejects a same-length-but-different Basic password (real compare, not length-only)', () => {
    const sameLen = 'x'.repeat(SECRET.length);
    expect(sameLen.length).toBe(SECRET.length);
    rejects(ctx({ auth: basic('postmark', sameLen) }));
  });

  it('rejects a malformed Basic header', () => rejects(ctx({ auth: 'Basic !!!not-base64!!!' })));
});
