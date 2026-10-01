import * as Sentry from '@sentry/node';
import { env } from './env.js';
import { diagnosticType, safeError } from './diagnostics.js';

export const sentryEnabled = Boolean(env.SENTRY_DSN);
const REPORT_KINDS = ['api-error', 'maestro-signin', 'audit-tamper'] as const;

// Rebuild instead of deleting known sensitive fields: breadcrumbs, contexts,
// exception messages/stacks, headers and future SDK fields can all contain PII.
export function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  const diagnostic = safeError(event.extra);
  const kind = REPORT_KINDS.find(kind => kind === event.extra?.kind) ?? 'api-error';
  return {
    type: undefined,
    ...(typeof event.event_id === 'string' && /^[a-f0-9]{32}$/.test(event.event_id) ? { event_id: event.event_id } : {}),
    ...(typeof event.timestamp === 'number' && Number.isFinite(event.timestamp) ? { timestamp: event.timestamp } : {}),
    platform: 'node',
    level: 'error',
    exception: { values: (event.exception?.values ?? []).map(value => ({
      type: diagnosticType(value.type), value: 'Error details omitted for privacy',
    })) },
    extra: { kind, code: diagnostic.code, ...('status' in diagnostic ? { status: diagnostic.status } : {}) },
  };
}

if (sentryEnabled) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT || 'development',
    tracesSampleRate: 0,
    sendDefaultPii: false,
    // Only explicit application reports; automatic integrations can collect
    // request data or send additional telemetry outside beforeSend.
    defaultIntegrations: false,
    beforeSend(event, hint) {
      hint.attachments = [];
      return scrubEvent(event);
    },
  });
}

export function captureException(err: unknown, kind: typeof REPORT_KINDS[number] = 'api-error'): void {
  if (!sentryEnabled) return;
  const diagnostic = safeError(err);
  const report = new Error('Error details omitted for privacy');
  report.name = diagnostic.type;
  Sentry.captureException(report, { extra: { ...diagnostic, kind } });
}

export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!sentryEnabled) return;
  try { await Sentry.flush(timeoutMs); }
  catch (err) { console.warn('[sentry] flush failed:', safeError(err)); }
}
