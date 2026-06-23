// Live ops-alert fan-out. When something critical happens — an audit-chain
// tamper, an unhandled API error, a failed cron — sendOpsAlert pushes a message
// to every configured channel (email via Postmark, Slack via incoming webhook).
//
// Three properties make this safe to call from anywhere, including error paths:
//   1. Env-gated per channel. Email needs Postmark + ALERT_EMAIL_TO; Slack needs
//      SLACK_ALERT_WEBHOOK_URL. With neither set, sendOpsAlert is a no-op — like
//      the Sentry DSN gate, turning it on is pure config.
//   2. De-duplicated. claim_ops_alert (Postgres) collapses a storm of the same
//      signature into one message per cooldown, so a failing route can't email
//      you hundreds of times. Fails OPEN: a dedup outage never silences alerts.
//   3. Best-effort + bounded. Every delivery is wrapped in a timeout and its own
//      try/catch; a channel failure is logged, never thrown. Alerting must not
//      take down the thing that triggered it.
//
// PII rule: the `detail` passed in MUST NOT contain player/customer PII. These
// messages land in inboxes and Slack — keep them to error types, ids, counts.

import { env } from './env.js';
import { getDb } from './db.js';
import { sendEmail, isPostmarkConfigured } from './postmark-outbound.js';

export type AlertSeverity = 'critical' | 'warning';

export interface OpsAlert {
  // Stable de-dup key — same signature within the cooldown collapses to one
  // message. Build it from kind + location, never from volatile data.
  signature: string;
  title: string;   // one-line summary → email subject / Slack header
  detail: string;  // body; NO player/customer PII
  severity?: AlertSeverity;
}

const COOLDOWN_SECONDS = 3600;   // at most one message per signature per hour
const DELIVERY_TIMEOUT_MS = 5000;

export function alertingConfigured(): boolean {
  return Boolean((isPostmarkConfigured() && env.ALERT_EMAIL_TO) || env.SLACK_ALERT_WEBHOOK_URL);
}

export async function sendOpsAlert(alert: OpsAlert): Promise<void> {
  if (!alertingConfigured()) return;

  let shouldSend = true;
  let suppressedSince = 0;
  try {
    const sql = getDb();
    const rows = await sql<{ should_send: boolean; suppressed_since: number }[]>`
      select should_send, suppressed_since from claim_ops_alert(${alert.signature}, ${COOLDOWN_SECONDS})
    `;
    shouldSend = rows[0]?.should_send ?? true;
    suppressedSince = rows[0]?.suppressed_since ?? 0;
  } catch (err) {
    // Fail open — a dedup outage must not swallow a real alert.
    console.warn('[alert] dedup claim failed, sending anyway:', errMsg(err));
  }
  if (!shouldSend) return;

  const severity = alert.severity ?? 'critical';
  let body = alert.detail;
  if (suppressedSince > 0) {
    body += `\n\n(${suppressedSince} more occurrence(s) of this alert were suppressed in the previous hour.)`;
  }

  await Promise.allSettled([
    deliverEmail(severity, alert.title, body),
    deliverSlack(severity, alert.title, body),
  ]);
}

function envName(): string {
  return env.SENTRY_ENVIRONMENT || process.env.VERCEL_ENV || 'local';
}

async function deliverEmail(severity: AlertSeverity, title: string, body: string): Promise<void> {
  if (!isPostmarkConfigured() || !env.ALERT_EMAIL_TO) return;
  try {
    await withTimeout(
      sendEmail({
        to: env.ALERT_EMAIL_TO,
        subject: `[maestro-desk ${severity}] ${title}`,
        textBody: `${body}\n\n— maestro-desk ops alerts (${envName()})`,
        fromEmail: env.POSTMARK_OUTBOUND_FROM,
        fromName: 'maestro-desk alerts',
      }),
      DELIVERY_TIMEOUT_MS,
    );
  } catch (err) {
    console.error('[alert] email delivery failed:', errMsg(err));
  }
}

async function deliverSlack(severity: AlertSeverity, title: string, body: string): Promise<void> {
  const url = env.SLACK_ALERT_WEBHOOK_URL;
  if (!url) return;
  const emoji = severity === 'critical' ? ':rotating_light:' : ':warning:';
  try {
    const res = await withTimeout(
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `${emoji} *[${envName()}] ${title}*\n${body}` }),
      }),
      DELIVERY_TIMEOUT_MS,
    );
    if (!res.ok) console.error(`[alert] slack webhook returned HTTP ${res.status}`);
  } catch (err) {
    console.error('[alert] slack delivery failed:', errMsg(err));
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
