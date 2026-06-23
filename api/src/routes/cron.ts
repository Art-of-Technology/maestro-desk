import { Hono } from 'hono';
import { env } from '../lib/env.js';
import { getDb } from '../lib/db.js';
import { processPendingDeliveries } from '../lib/outgoing-webhooks.js';
import { purgeExpiredTickets } from '../lib/retention.js';
import { verifyAuditChains } from '../lib/audit-verify.js';
import { sendOpsAlert } from '../lib/alert.js';

// A cron job failed to run cleanly — fire a live alert (no-op until a channel
// is configured) so a silently-broken scheduled task surfaces. Signature is per
// job, so one alert per job per cooldown.
async function alertCronFailure(job: string, err: unknown): Promise<void> {
  await sendOpsAlert({
    signature: `cron:${job}:fail`,
    severity: 'critical',
    title: `Cron job "${job}" failed`,
    detail: `The scheduled "${job}" job threw: ${err instanceof Error ? err.message : String(err)}`,
  });
}

// Vercel Cron endpoints (Step 6). Vercel invokes these with a GET on the
// schedule in vercel.json and sends `Authorization: Bearer ${CRON_SECRET}`;
// we reject anything without the matching secret. On the Hobby plan crons fire
// once/day, so webhook FIRST attempts go out inline at the event
// (lib/outgoing-webhooks) — this endpoint is the retry sweep. The underlying
// processPendingDeliveries claims work with FOR UPDATE SKIP LOCKED, so a
// duplicate invocation is safe.
export const cron = new Hono();

// Ops guard: on Vercel an unset CRON_SECRET silently 401s every cron request,
// so the scheduled webhook-retry job would never run with no obvious signal.
// Warn loudly at boot. (Locally it's expected — the in-process worker does the
// sweeping and the endpoints stay closed.)
if (process.env.VERCEL && !env.CRON_SECRET) {
  console.warn(
    '[cron] CRON_SECRET is not set on Vercel — all /api/v1/cron/* requests will 401 and the ' +
      'scheduled webhook-retry job will NOT run. Set CRON_SECRET in the project env.',
  );
}

cron.use('*', async (c, next) => {
  const secret = env.CRON_SECRET;
  // No secret configured → endpoint is closed (local dev uses the in-process
  // worker instead). With a secret, require the exact bearer Vercel sends.
  if (!secret || c.req.header('Authorization') !== `Bearer ${secret}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});

cron.get('/webhook-retry', async (c) => {
  let processed: number;
  try {
    ({ processed } = await processPendingDeliveries());
  } catch (err) {
    console.error('[cron] webhook-retry failed:', err instanceof Error ? err.message : err);
    await alertCronFailure('webhook-retry', err);
    return c.json({ ok: false, error: 'webhook-retry failed' }, 500);
  }
  // Piggyback the daily housekeeping prunes (drop long-expired rate-limit
  // buckets and stale ops-alert dedup signatures). Best-effort.
  try { await getDb()`select prune_rate_limits()`; }
  catch (err) { console.warn('[cron] prune_rate_limits failed:', err instanceof Error ? err.message : err); }
  try { await getDb()`select prune_ops_alerts()`; }
  catch (err) { console.warn('[cron] prune_ops_alerts failed:', err instanceof Error ? err.message : err); }
  return c.json({ ok: true, processed });
});

// Data-retention purge — deletes resolved tickets (and cascaded children) past
// each workspace's retention window. Idempotent: a re-run just deletes whatever
// is now expired. Safe to run daily.
cron.get('/retention', async (c) => {
  let purgedTickets: number;
  try {
    ({ purgedTickets } = await purgeExpiredTickets());
  } catch (err) {
    console.error('[cron] retention purge failed:', err instanceof Error ? err.message : err);
    await alertCronFailure('retention', err);
    return c.json({ ok: false, error: 'retention purge failed' }, 500);
  }
  // Piggyback the daily audit-chain integrity check. The Hobby plan caps the
  // number of cron jobs, so rather than spend a slot, this compliance sweep
  // rides the existing daily compliance cron. Best-effort: a verify failure is
  // logged/alerted inside verifyAuditChains but must not fail the purge result.
  // We embed only a COUNT here to keep the retention payload light; the
  // standalone /audit-verify returns the full tampered array. The alert itself
  // (Sentry, in verifyAuditChains) fires regardless of which caller ran it.
  let audit: { checked: number; tampered: number } | undefined;
  try {
    const { checked, tampered } = await verifyAuditChains();
    audit = { checked, tampered: tampered.length };
  } catch (err) {
    console.error('[cron] audit-verify (via retention) failed:', err instanceof Error ? err.message : err);
    await alertCronFailure('audit-verify', err);
  }
  return c.json({ ok: true, purgedTickets, audit });
});

// Audit-chain integrity check (standalone). Recomputes every workspace's
// audit_events hash chain and reports tampered chains; the alert (Sentry + loud
// log) fires inside verifyAuditChains. The scheduled run rides /retention above
// (Hobby cron-count cap); this route exists for manual/ad-hoc checks — curl it
// with the CRON_SECRET bearer — and is what the tests exercise.
cron.get('/audit-verify', async (c) => {
  try {
    const { checked, tampered } = await verifyAuditChains();
    // `ok` reflects audit HEALTH, not merely "the call ran": an operator or
    // monitor can treat ok:false as "tamper detected" without parsing the
    // array. A failure to RUN the check is a different signal — HTTP 500 below.
    return c.json({ ok: tampered.length === 0, checked, tamperedCount: tampered.length, tampered });
  } catch (err) {
    console.error('[cron] audit-verify failed:', err instanceof Error ? err.message : err);
    await alertCronFailure('audit-verify', err);
    return c.json({ ok: false, error: 'audit-verify failed' }, 500);
  }
});
