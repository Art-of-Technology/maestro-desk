// CLI entry for scheduled jobs on self-hosted deploys. The Dokploy schedules
// exec this INSIDE the running API container (same env, same DB) instead of
// curling the HTTP endpoints — no CRON_SECRET round-trip, and a long retention
// sweep can't be severed by an HTTP idle/request timeout. Vercel keeps using
// the HTTP endpoints (routes/cron.ts); both call the same lib/cron-jobs.ts
// implementations. Exit code is the scheduler's failure signal; job failures
// additionally fire ops alerts inside the job (alertCronFailure).
//
//   node --import tsx src/cron-run.ts webhook-retry
//   node --import tsx src/cron-run.ts retention
import { runRetentionJob, runWebhookRetryJob } from './lib/cron-jobs.js';

const jobs: Record<string, () => Promise<unknown>> = {
  'webhook-retry': runWebhookRetryJob,
  retention: runRetentionJob,
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
