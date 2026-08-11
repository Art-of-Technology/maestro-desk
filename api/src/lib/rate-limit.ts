import type { Context } from 'hono';
import { ipAddress } from '@vercel/functions';
import { getConnInfo } from '@hono/node-server/conninfo';
import { getDb } from './db.js';
import { env } from './env.js';
import { isBlockedAddress } from './ssrf.js';

// Postgres-backed fixed-window rate limiting for the public portal (see
// migration 20260619150000). Used like the authz helpers: returns a shaped 429
// Response when the caller is over the limit, or null to proceed.
//
//   const limited = await enforceRateLimit(c, { name: 'tickets', max: 10, windowSeconds: 600 });
//   if (limited) return limited;

// Trusted client IP — the sole key for every per-IP limit bucket (auth
// brute-force caps included), so it must not be attacker-mintable.
//
// TRUST_PROXY=1 (self-hosted, Dokploy/Traefik): Traefik APPENDS the real TCP
// peer to X-Forwarded-For, so the RIGHT-most entry is the one our own edge
// wrote — but only for connections that actually came THROUGH Traefik. We
// check the raw TCP peer (getConnInfo): a private/internal peer is the overlay
// network (Traefik), so believe its appended entry; a public peer reached the
// container directly (published port), so key on that real address instead —
// a fake XFF then buys the attacker nothing. x-real-ip is deliberately ignored
// in this mode (Traefik doesn't set it; a client can). Sibling containers on
// the overlay could still forge XFF, but anything on that network is already
// inside the trust boundary (it can reach the DB creds directly).
//
// Otherwise (Vercel / local dev): ipAddress() reads Vercel's edge-set header,
// which a client cannot spoof; dev falls back to left-most XFF / x-real-ip.
// Anything unattributable shares one 'unknown' bucket so those requests are
// still collectively capped (fail-closed on identity).
//
// trustProxy is injectable for tests — env is parsed once at module load.
export function clientIp(c: Context, trustProxy: boolean = env.TRUST_PROXY): string {
  if (trustProxy) {
    let conn = '';
    try {
      conn = getConnInfo(c).remote.address ?? '';
    } catch {
      // Not running under @hono/node-server (bun test drives app.request()
      // without a socket) — fall through to the shared 'unknown' bucket.
    }
    if (conn && !isBlockedAddress(conn)) return conn;
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
      const last = parts[parts.length - 1];
      if (last) return last;
    }
    return conn || 'unknown';
  }
  const trusted = ipAddress(c.req.raw);
  if (trusted) return trusted;
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return c.req.header('x-real-ip')?.trim() || 'unknown';
}

export interface RateLimitOptions {
  /** Stable name for the limited action, e.g. 'tickets' — prefixes the bucket. */
  name: string;
  /** Max requests allowed per window. */
  max: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /**
   * Extra bucket discriminator(s) beyond the client IP — e.g. an email so
   * magic-link requests are also capped per target address. Omit to key by IP
   * alone.
   */
  by?: string;
  /**
   * When the limiter itself errors (DB unreachable), the default is to fail
   * OPEN (allow the request) so a transient hiccup doesn't take the surface
   * down. Set this for COST-BEARING actions (sending email, LLM calls) where
   * allowing unbounded requests during a DB outage is worse than a brief 503 —
   * the limiter then fails CLOSED (returns a 503) instead.
   */
  failClosed?: boolean;
}

// Decision for when the limiter itself errors (DB unreachable): cost-bearing
// callers fail CLOSED (a brief 503 beats unbounded email/LLM spend); everything
// else fails OPEN (null → proceed) so a transient DB hiccup doesn't take the
// portal down. Exported so it can be unit-tested without fault-injecting the DB.
export function limiterErrorResult(c: Context, opts: Pick<RateLimitOptions, 'failClosed' | 'windowSeconds'>): Response | null {
  if (!opts.failClosed) return null;
  return c.json(
    { error: 'Service temporarily unavailable — please try again shortly.' },
    503,
    { 'Retry-After': String(opts.windowSeconds) },
  );
}

export async function enforceRateLimit(c: Context, opts: RateLimitOptions): Promise<Response | null> {
  const sql = getDb();
  const bucket = opts.by
    ? `${opts.name}:${opts.by}`
    : `${opts.name}:${clientIp(c)}`;

  let allowed = true;
  let retryAfter = opts.windowSeconds;
  try {
    const [row] = await sql<{ allowed: boolean; retry_after: number }[]>`
      select allowed, retry_after from check_rate_limit(${bucket}, ${opts.max}, ${opts.windowSeconds})
    `;
    if (row) { allowed = row.allowed; retryAfter = row.retry_after; }
  } catch (err) {
    console.warn('[rate-limit] check failed:', err instanceof Error ? err.message : err);
    return limiterErrorResult(c, opts);
  }

  if (allowed) return null;
  return c.json(
    { error: 'Too many requests — please slow down and try again shortly.' },
    429,
    { 'Retry-After': String(retryAfter) },
  );
}
