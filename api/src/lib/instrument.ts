import * as Sentry from '@sentry/node';
import { env } from './env.js';

// Sentry error tracking. DSN-gated: when SENTRY_DSN is empty (the default and
// the state in CI/local), Sentry.init is NEVER called, so captureException and
// flushSentry below are no-ops and the app runs exactly as before. Turning it
// on is a one-variable flip in the Vercel env — no code change.
//
// Errors only — tracesSampleRate is 0 (no perf tracing) and sendDefaultPii is
// false. The beforeSend scrubber below is the GDPR backstop: Sentry must never
// become a second store of player/customer PII or secrets, so request bodies,
// auth headers, cookies, query strings and user identifiers are stripped from
// every event. Stack traces + error types are all we send.

export const sentryEnabled = Boolean(env.SENTRY_DSN);

// Exported for unit testing — strips PII / secrets from an outgoing event.
export function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.request) {
    delete event.request.data;          // request body (may contain message text / PII)
    delete event.request.cookies;
    delete event.request.query_string;  // tokens, emails sometimes ride here
    const h = event.request.headers as Record<string, unknown> | undefined;
    if (h) {
      for (const key of ['authorization', 'Authorization', 'cookie', 'Cookie',
                         'x-workspace-id', 'X-Workspace-Id']) {
        delete h[key];
      }
    }
  }
  delete event.user;                     // no user id / email / ip
  return event;
}

if (sentryEnabled) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT || process.env.VERCEL_ENV || 'development',
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend: scrubEvent,
  });
}

// Report an unhandled error. No-op until Sentry.init has run (DSN unset).
export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!sentryEnabled) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

// Flush pending events before a serverless function freezes/returns. Vercel can
// suspend the instance immediately after the response, so events queued by
// captureException must be sent first. Best-effort + bounded; no-op when off.
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!sentryEnabled) return;
  try { await Sentry.flush(timeoutMs); } catch { /* best-effort — never throw from logging */ }
}
