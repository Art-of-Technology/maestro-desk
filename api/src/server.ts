// Production entry for self-hosted deploys (Dokploy/Docker). Runs on NODE,
// deliberately not Bun: the connect-time SSRF guard on outbound webhook
// deliveries (lib/ssrf.ts safeLookup via an undici Agent — hardening PR #412)
// only engages on Node. Bun's fetch ignores undici dispatchers AND ignores a
// custom `lookup` on node:https Agents (both verified empirically), so a Bun
// production server would silently drop the DNS-rebinding protection. Vercel
// production runs Node too, so this also keeps runtime parity; Bun remains
// the dev/test runtime (src/dev.ts, bun test).
import { serve } from '@hono/node-server';
import app from './index.js';
import { env } from './lib/env.js';
import { startWebhookWorker, stopWebhookWorker } from './lib/outgoing-webhooks.js';

// First webhook attempts fire inline at dispatch (lib/outgoing-webhooks.ts,
// non-Vercel branch), so this poll only catches RETRIES, whose backoff is
// minutes-to-hours. 10 min (vs the dev-oriented 5s default) leaves an
// otherwise-idle Neon endpoint free to autosuspend instead of being pinned
// awake by ~17k queries/day.
const RETRY_POLL_MS = 10 * 60 * 1000;

// CRON_SECRET matters on this host too: the nightly jobs are driven by
// .github/workflows/cron-jobs.yml calling the HTTP cron endpoints (the Dokploy
// in-container schedules stopped working — PROD_SETUP.md → Scheduled jobs).
// routes/cron.ts warns at load when it is unset on any non-local deploy.

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`respovia API (node) listening on :${info.port} — TRUST_PROXY=${env.TRUST_PROXY}`);
});
startWebhookWorker(RETRY_POLL_MS);

// Graceful drain on Dokploy redeploys/restarts: stop the retry poll, stop
// accepting new connections, let in-flight requests (AI triage runs ~12s)
// finish inside Docker's stop grace, then exit. The fallback timer hard-exits
// if a socket refuses to close; unref'd so it never holds a clean exit open.
function shutdown(signal: string): void {
  console.log(`[server] ${signal} received — draining`);
  stopWebhookWorker();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 9_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
