import { Hono } from 'hono';
import { env } from '../lib/env.js';
import { verifyAuditChainsFull } from '../lib/audit-verify.js';
import { alertCronFailure, runRetentionJob, runWebhookRetryJob } from '../lib/cron-jobs.js';

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
      'scheduled jobs (webhook-retry, retention) will NOT run. Set CRON_SECRET in the project env.',
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

// The job bodies live in lib/cron-jobs.ts, shared with the self-hosted CLI
// runner (src/cron-run.ts) — logging + ops alerts fire inside the job; these
// handlers only translate the outcome to HTTP.
cron.get('/webhook-retry', async (c) => {
  try {
    return c.json({ ok: true, ...(await runWebhookRetryJob()) });
  } catch {
    return c.json({ ok: false, error: 'webhook-retry failed' }, 500);
  }
});

// Data-retention purge + piggybacked compliance sweeps (audit-chain verify,
// GDPR object-deletion retry, sender-domain sweep) — composition and the
// reasoning comments live in lib/cron-jobs.ts runRetentionJob.
cron.get('/retention', async (c) => {
  try {
    return c.json({ ok: true, ...(await runRetentionJob()) });
  } catch {
    return c.json({ ok: false, error: 'retention purge failed' }, 500);
  }
});

// Audit-chain integrity check (standalone). Runs the FULL, read-only verifier
// (recomputes every workspace's chain from genesis, writes no checkpoints) so an
// ad-hoc audit is authoritative and side-effect-free — independent of the daily
// incremental checkpoints. The alert (Sentry + loud log) fires inside the
// verifier. The scheduled run rides /retention above (Hobby cron-count cap);
// this route is for manual/ad-hoc checks — curl it with the CRON_SECRET bearer.
cron.get('/audit-verify', async (c) => {
  try {
    const { checked, tampered } = await verifyAuditChainsFull();
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
