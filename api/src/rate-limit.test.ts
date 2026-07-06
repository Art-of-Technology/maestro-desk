// Unit test for the limiter's fail-open vs fail-closed decision on a DB error
// (advisory #13). We test the pure `limiterErrorResult` directly — no DB, no
// module mock (which would leak into other test files), no fault injection.

import { describe, expect, it } from 'bun:test';
import type { Context } from 'hono';
import { limiterErrorResult } from './lib/rate-limit.js';

// Minimal Context exposing only the `json` helper the function uses.
const ctx = (): Context =>
  ({
    json: (obj: unknown, status?: number, hdrs?: Record<string, string>) =>
      new Response(JSON.stringify(obj), { status: status ?? 200, headers: hdrs }),
  }) as unknown as Context;

describe('limiterErrorResult (limiter DB error)', () => {
  it('fails OPEN by default (returns null → request proceeds)', () => {
    expect(limiterErrorResult(ctx(), { windowSeconds: 60 })).toBeNull();
    expect(limiterErrorResult(ctx(), { failClosed: false, windowSeconds: 60 })).toBeNull();
  });

  it('fails CLOSED when failClosed is set (503 with Retry-After)', () => {
    const res = limiterErrorResult(ctx(), { failClosed: true, windowSeconds: 90 });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
    expect(res!.headers.get('Retry-After')).toBe('90');
  });
});
