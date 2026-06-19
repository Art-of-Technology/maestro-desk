import type { Context } from 'hono';
import { getDb } from './db.js';

// Postgres-backed fixed-window rate limiting for the public portal (see
// migration 20260619150000). Used like the authz helpers: returns a shaped 429
// Response when the caller is over the limit, or null to proceed.
//
//   const limited = await enforceRateLimit(c, { name: 'tickets', max: 10, windowSeconds: 600 });
//   if (limited) return limited;

// Best-effort client IP. On Vercel the real client is the left-most entry of
// X-Forwarded-For; fall back to X-Real-IP, then a shared 'unknown' bucket so
// requests we can't attribute are still collectively capped (fail-closed).
export function clientIp(c: Context): string {
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
    // Fail OPEN on a limiter error: a transient DB hiccup must not take down
    // the portal. The error is logged; the request proceeds.
    console.warn('[rate-limit] check failed, allowing request:', err instanceof Error ? err.message : err);
    return null;
  }

  if (allowed) return null;
  return c.json(
    { error: 'Too many requests — please slow down and try again shortly.' },
    429,
    { 'Retry-After': String(retryAfter) },
  );
}
