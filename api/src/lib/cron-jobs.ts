// Scheduled-job implementations, shared by BOTH invocation paths:
//   - routes/cron.ts    — HTTP endpoints (Vercel Cron / manual curl, CRON_SECRET-gated)
//   - src/cron-run.ts   — CLI entry (self-hosted Dokploy schedules exec it in-container)
// Keeping the composition here means the two schedulers can never drift on
// WHAT a job does — only on when/how it's triggered.
import { getDb } from './db.js';
import { processPendingDeliveries } from './outgoing-webhooks.js';
import { purgeExpiredTickets } from './retention.js';
import { retryPendingObjectDeletions } from './gdpr-erasure.js';
import { verifyAuditChains } from './audit-verify.js';
import { sweepEmailDomains } from './email-domains.js';
import { sendOpsAlert } from './alert.js';

// A cron job failed to run cleanly — fire a live alert (no-op until a channel
// is configured) so a silently-broken scheduled task surfaces. Signature is per
// job, so one alert per job per cooldown.
export async function alertCronFailure(job: string, err: unknown): Promise<void> {
  await sendOpsAlert({
    signature: `cron:${job}:fail`,
    severity: 'critical',
    title: `Cron job "${job}" failed`,
    detail: `The scheduled "${job}" job threw: ${err instanceof Error ? err.message : String(err)}`,
  });
}

// Webhook retry sweep. First attempts fire at dispatch time (inline flush /
// waitUntil in lib/outgoing-webhooks.ts), so this only catches rows whose
// retry backoff elapsed. Throws after alerting when the core sweep fails —
// callers translate that into their own failure signal (HTTP 500 / exit 1).
export async function runWebhookRetryJob(): Promise<{ processed: number }> {
  let processed: number;
  try {
    ({ processed } = await processPendingDeliveries());
  } catch (err) {
    console.error('[cron] webhook-retry failed:', err instanceof Error ? err.message : err);
    await alertCronFailure('webhook-retry', err);
    throw err;
  }
  // Piggyback the daily housekeeping prunes (drop long-expired rate-limit
  // buckets and stale ops-alert dedup signatures). Best-effort.
  try { await getDb()`select prune_rate_limits()`; }
  catch (err) { console.warn('[cron] prune_rate_limits failed:', err instanceof Error ? err.message : err); }
  try { await getDb()`select prune_ops_alerts()`; }
  catch (err) { console.warn('[cron] prune_ops_alerts failed:', err instanceof Error ? err.message : err); }
  return { processed };
}

export interface RetentionJobResult {
  purgedTickets: number;
  audit?: { checked: number; tampered: number; full: boolean };
  objectRetry?: { swept: number; cleared: number };
  emailDomains?: Awaited<ReturnType<typeof sweepEmailDomains>>;
}

// Data-retention purge — deletes resolved tickets (and cascaded children) past
// each workspace's retention window. Idempotent: a re-run just deletes whatever
// is now expired. Safe to run daily. Throws (after alerting) only when the
// core purge fails; the piggybacked sweeps are best-effort with their own
// alerts, mirroring the original route semantics.
export async function runRetentionJob(): Promise<RetentionJobResult> {
  let purgedTickets: number;
  try {
    ({ purgedTickets } = await purgeExpiredTickets());
  } catch (err) {
    console.error('[cron] retention purge failed:', err instanceof Error ? err.message : err);
    await alertCronFailure('retention', err);
    throw err;
  }
  const result: RetentionJobResult = { purgedTickets };
  // Piggyback the daily audit-chain integrity check (Hobby plan caps cron jobs,
  // so this compliance sweep rides the existing daily cron rather than spending a
  // slot). Incremental by default (cost ∝ new rows); a full re-verify runs weekly
  // (Sundays, UTC) via resetFirst to catch a historical tamper below a checkpoint
  // — a stateless calendar gate, so a missed Sunday just delays a week. Best-
  // effort: a verify failure is logged/alerted inside verifyAuditChains but must
  // not fail the purge result. Only a COUNT is embedded here; the alert (Sentry +
  // ops) fires inside verifyAuditChains regardless of caller.
  try {
    const full = new Date().getUTCDay() === 0;
    const { checked, tampered } = await verifyAuditChains({ resetFirst: full });
    result.audit = { checked, tampered: tampered.length, full };
  } catch (err) {
    console.error('[cron] audit-verify (via retention) failed:', err instanceof Error ? err.message : err);
    await alertCronFailure('audit-verify', err);
  }
  // Piggyback the GDPR-erasure object-deletion retry sweep (finishes any R2
  // deletes that failed at erase time). Best-effort — a failure here must not
  // fail the purge result.
  try {
    const { swept, cleared } = await retryPendingObjectDeletions();
    result.objectRetry = { swept, cleared };
  } catch (err) {
    console.error('[cron] gdpr object-deletion retry (via retention) failed:', err instanceof Error ? err.message : err);
    await alertCronFailure('gdpr-object-retry', err);
  }
  // Piggyback the sender-domain sweep (same Hobby cron-cap reasoning): verify
  // pending domains (auto-stamps owners who never revisit the settings page),
  // drift-check verified ones (lapse => degraded + ops alert inside the
  // sweep), and expire 30-day-old unverified claims. Best-effort.
  try {
    result.emailDomains = await sweepEmailDomains();
  } catch (err) {
    console.error('[cron] email-domain sweep (via retention) failed:', err instanceof Error ? err.message : err);
    await alertCronFailure('email-domain-sweep', err);
  }
  return result;
}
