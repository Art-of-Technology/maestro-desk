// Local dev entry (Bun). Production (Vercel) uses src/index.ts —
// `export default app` — and runs the background work via Vercel Cron
// (routes/cron.ts) + inline delivery. This file is what `bun run dev`/`start`
// load: it wraps the same Hono app in Bun.serve and starts the in-process
// workers, so local dev keeps the always-on polling behavior. Vercel never
// imports this file.
import app from './index.js';
import { env } from './lib/env.js';
import { startWebhookWorker } from './lib/outgoing-webhooks.js';

console.log(`maestro-desk API listening on http://localhost:${env.PORT}`);

// In-process workers — local only (this file isn't loaded on Vercel).
startWebhookWorker();

export default {
  port: env.PORT,
  // Triage and other AI calls can run ~12s; Bun's default idleTimeout is 10s,
  // which would close the socket mid-response. Raise it for local dev.
  idleTimeout: 30,
  fetch: app.fetch,
};
