// Production entry for self-hosted deploys (Dokploy/Docker). Vercel uses
// src/index.ts (`export default app` + Vercel Cron); local dev uses src/dev.ts
// (--hot). This file is the always-on Bun server: it wraps the same Hono app
// in Bun.serve and starts the in-process webhook worker, which replaces
// Vercel's inline waitUntil delivery (lib/outgoing-webhooks.ts skips the
// inline flush when process.env.VERCEL is unset — the worker picks new rows
// up within ~5s). Scheduled jobs (retry sweep, retention) still run through
// routes/cron.ts, invoked by the platform scheduler with CRON_SECRET.
import app from './index.js';
import { env } from './lib/env.js';
import { startWebhookWorker } from './lib/outgoing-webhooks.js';

// Same ops guard as the Vercel path (routes/cron.ts warns only when VERCEL is
// set): self-hosted, an unset CRON_SECRET means every /api/v1/cron/* request
// 401s and the retention/retry schedules silently never run.
if (!env.CRON_SECRET) {
  console.warn(
    '[server] CRON_SECRET is not set — /api/v1/cron/* will 401 and scheduled ' +
      'jobs (webhook-retry, retention) will NOT run. Set CRON_SECRET in the env.',
  );
}

console.log(`respovia API listening on :${env.PORT}`);

startWebhookWorker();

export default {
  port: env.PORT,
  // Triage and other AI calls can run ~12s; Bun's default idleTimeout is 10s,
  // which would close the socket mid-response (same setting as src/dev.ts).
  idleTimeout: 30,
  fetch: app.fetch,
};
