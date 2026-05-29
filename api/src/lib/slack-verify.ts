// Slack signs every event-POST with HMAC-SHA256 over
// `v0:<timestamp>:<raw-body>` using the app's signing secret. We
// recompute and compare in constant time. Also reject requests with a
// timestamp older than 5 minutes to blunt replay attacks (per Slack's
// own guidance).
//
// The signing secret is the per-app secret found in
// https://api.slack.com/apps/<id>/general#app_credentials — NOT the
// bot token. Distinct workspaces have distinct signing secrets, so
// we verify against the integration row's secret after picking the
// candidate workspace from the team_id in the payload.

import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_AGE_SEC = 300;

export interface SlackVerifyArgs {
  signingSecret: string;
  signature:     string | null;
  timestamp:     string | null;
  rawBody:       string;
}

export function verifySlackSignature(args: SlackVerifyArgs): { ok: true } | { ok: false; reason: string } {
  const { signingSecret, signature, timestamp, rawBody } = args;
  if (!signature || !timestamp) return { ok: false, reason: 'missing signature headers' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' };
  const ageSec = Math.abs(Date.now() / 1000 - ts);
  if (ageSec > MAX_AGE_SEC) return { ok: false, reason: 'stale timestamp' };

  const base = `v0:${timestamp}:${rawBody}`;
  const computed = 'v0=' + createHmac('sha256', signingSecret).update(base).digest('hex');

  const a = Buffer.from(signature);
  const b = Buffer.from(computed);
  if (a.length !== b.length) return { ok: false, reason: 'signature length mismatch' };
  if (!timingSafeEqual(a, b)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}
