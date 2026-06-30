import type { MiddlewareHandler } from 'hono';
import { enforceRateLimit } from './rate-limit.js';

// Rate limiting for the better-auth surface (/api/auth/*). The auth handler is
// mounted raw in index.ts with no throttling, leaving sign-in, password-reset
// request, and reset-consume open to credential-stuffing / brute-force and
// reset-email bombing (advisory GHSA-6qq2-v492-r8r6 #5). This middleware fronts
// the handler and applies the existing Postgres-backed enforceRateLimit (the
// same limiter the portal uses, see routes/public.ts) to the sensitive POSTs.
//
// Keyed BOTH per-IP (caps a single noisy source) and per-email where a target
// address is meaningful (caps brute-force / reset-bombing of one account
// regardless of source IP). Runs BEFORE the handler, so failed attempts count.

interface Policy {
  /** distinct bucket prefix (must not collide with portal buckets) */
  ipName: string;
  ipMax: number;
  /** if set, also limit per submitted email */
  emailName?: string;
  emailMax?: number;
  windowSeconds: number;
}

// Match by path tail so it's independent of the mount prefix.
function policyFor(path: string): Policy | null {
  if (path.endsWith('/sign-in/email')) {
    return { ipName: 'auth-login-ip', ipMax: 20, emailName: 'auth-login-email', emailMax: 10, windowSeconds: 600 };
  }
  if (path.endsWith('/request-password-reset')) {
    return { ipName: 'auth-reset-req-ip', ipMax: 5, emailName: 'auth-reset-req-email', emailMax: 5, windowSeconds: 900 };
  }
  if (path.endsWith('/reset-password')) {
    return { ipName: 'auth-reset-consume-ip', ipMax: 20, windowSeconds: 900 };
  }
  if (path.endsWith('/sign-up/email')) {
    return { ipName: 'auth-signup-ip', ipMax: 5, windowSeconds: 3600 };
  }
  return null;
}

export const authRateLimit: MiddlewareHandler = async (c, next) => {
  // Only POSTs carry credentials / trigger emails; GET (get-session) and the
  // OAuth callbacks must stay unthrottled.
  if (c.req.method !== 'POST') return next();

  const policy = policyFor(c.req.path);
  if (!policy) return next();

  // Per-IP bucket always applies.
  const ipLimited = await enforceRateLimit(c, { name: policy.ipName, max: policy.ipMax, windowSeconds: policy.windowSeconds });
  if (ipLimited) return ipLimited;

  // Per-email bucket where the body carries a target address. Read a CLONE so
  // auth.handler(c.req.raw) still sees an intact body; a malformed/empty body
  // just skips this bucket (the IP bucket already applied).
  if (policy.emailName) {
    let email: string | undefined;
    try {
      const body = (await c.req.raw.clone().json()) as { email?: unknown };
      if (typeof body?.email === 'string' && body.email) email = body.email.toLowerCase();
    } catch {
      // not JSON / no body — skip the email bucket
    }
    if (email) {
      const emailLimited = await enforceRateLimit(c, { name: policy.emailName, by: email, max: policy.emailMax!, windowSeconds: policy.windowSeconds });
      if (emailLimited) return emailLimited;
    }
  }

  return next();
};
