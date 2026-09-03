// CLI entry for the scheduled jobs — exec'd INSIDE the API container (same
// env, same DB). Designed for the Dokploy application schedules
// (deploy/dokploy/provision-schedules.mjs), which have been FAILING since late
// August 2026 ("Container not found for application …" — the panel cannot
// exec into the container). The scheduler of record is therefore the GitHub
// Actions workflow .github/workflows/cron-jobs.yml, which calls the
// CRON_SECRET-gated HTTP endpoints in routes/cron.ts; this CLI remains for
// operators with a container shell and for when Dokploy exec is repaired. Both
// paths call the same lib/cron-jobs.ts implementations, so both log and fire
// ops alerts on failure (alertCronFailure); here the exit code is the extra
// signal. See PROD_SETUP.md → Scheduled jobs.
//
//   node --import tsx src/cron-run.ts webhook-retry
//   node --import tsx src/cron-run.ts retention
//   node --import tsx src/cron-run.ts player-identity-backfill   # run-once; repeat until remaining = 0
import { runPlayerIdentityBackfill, runRetentionJob, runWebhookRetryJob } from './lib/cron-jobs.js';

const jobs: Record<string, () => Promise<unknown>> = {
  'webhook-retry': runWebhookRetryJob,
  retention: runRetentionJob,
  // Not scheduled — an operator runs it once after the maestro-ids migration
  // to link pre-existing contacts. New contacts link themselves on creation.
  'player-identity-backfill': () => runPlayerIdentityBackfill(),
};

const name = process.argv[2] ?? '';
const job = jobs[name];
if (!job) {
  console.error(`usage: cron-run.ts <${Object.keys(jobs).join('|')}> (got ${JSON.stringify(name)})`);
  process.exit(2);
}

job().then(
  (result) => {
    console.log(`[cron-run] ${name} ok: ${JSON.stringify(result)}`);
    process.exit(0);
  },
  (err) => {
    console.error(`[cron-run] ${name} failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
