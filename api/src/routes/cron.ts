import { Hono } from 'hono';
import { env, isLocalDev } from '../lib/env.js';
import { verifyAuditChainsFull } from '../lib/audit-verify.js';
import { alertCronFailure, runPlayerIdentityBackfill, runRetentionJob, runWebhookRetryJob } from '../lib/cron-jobs.js';
import { BackfillAbortError, BackfillBusyError } from '../lib/player-identity.js';

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
//
// Self-hosted prod is gated the same way now: the GitHub Actions scheduler
// (.github/workflows/cron-jobs.yml) calls these endpoints, so an unset secret
// there means "every nightly run 401s" — warn on every non-local deploy.
if (!isLocalDev && !env.CRON_SECRET) {
  console.warn(
    '[cron] CRON_SECRET is not set — all /api/v1/cron/* requests will 401 and the ' +
      'scheduled jobs (webhook-retry, retention) will NOT run. Set CRON_SECRET in the deploy env ' +
      '(and PROD_CRON_SECRET in the GitHub repo secrets to the same value).',
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

// One-off Maestro player-identity backfill (lib/player-identity.ts). The
// same job as `cron-run.ts player-identity-backfill`, exposed over HTTP for
// hosts where Dokploy can't exec into the API container (its schedules fail
// with "Container not found" — see PROD_SETUP.md → Scheduled jobs). Not on a
// timer: an operator calls it with the CRON_SECRET bearer and repeats until
// `remaining` is 0. Idempotent — every contact it touches is linked or
// stamped.
//
// Bounded per call: api.respovia.com sits behind Cloudflare, which cuts any
// response past ~100 s (HTTP 524) while the handler keeps running blind. The
// default batch (100 contacts per brand, 4-wide gateway calls) finishes well
// inside that; `?perWorkspace=` may raise it to 500. The job is single-flight
// per process — a caller re-running after an edge timeout gets 409 instead of
// doubling the gateway load.
//
// Error policy: the job's own abort (dead token / consecutive gateway
// failures) is operator-facing — counts + hint, never values — and is
// forwarded. Anything else (DB down, schema mismatch) is logged + alerted
// inside runPlayerIdentityBackfill and surfaces as a FIXED string, like the
// sibling handlers: the workflow prints this body into a public Actions log.
const BACKFILL_DEFAULT_PER_WORKSPACE = 100;
const BACKFILL_MAX_PER_WORKSPACE = 500;
cron.get('/player-identity-backfill', async (c) => {
  const raw = Number(c.req.query('perWorkspace') ?? BACKFILL_DEFAULT_PER_WORKSPACE);
  const perWorkspace = Number.isInteger(raw) && raw > 0
    ? Math.min(raw, BACKFILL_MAX_PER_WORKSPACE)
    : BACKFILL_DEFAULT_PER_WORKSPACE;
  try {
    return c.json({ ok: true, perWorkspace, ...(await runPlayerIdentityBackfill({ perWorkspace })) });
  } catch (err) {
    if (err instanceof BackfillBusyError) return c.json({ ok: false, error: err.message }, 409);
    if (err instanceof BackfillAbortError) return c.json({ ok: false, error: err.message, ...err.result }, 500);
    return c.json({ ok: false, error: 'player-identity-backfill failed' }, 500);
  }
});
