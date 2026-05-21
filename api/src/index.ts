import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { HTTPException } from 'hono/http-exception';
import { env } from './lib/env.ts';
import { health } from './routes/health.ts';
import { me } from './routes/me.ts';
import { tickets } from './routes/tickets.ts';
import { triage } from './routes/triage.ts';
import { webhooks } from './routes/webhooks.ts';

const app = new Hono();

app.use('*', logger());
app.use('*', cors({
  origin: '*',  // Tighten before exposing publicly. For local dev, * is fine.
  allowHeaders: ['Authorization', 'Content-Type', 'X-Workspace-Id'],
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
}));

app.route('/api/v1/health', health);
app.route('/api/v1/me', me);
app.route('/api/v1/tickets', tickets);
app.route('/api/v1/tickets/:id/triage', triage);
app.route('/api/v1/webhooks', webhooks);

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  // Log the full error server-side; return message-only to the client (no stack).
  // Stack traces in API responses are a leak vector — keep them in the log.
  console.error('Unhandled error:', err);
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: 'Internal server error', detail: message }, 500);
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

console.log(`maestro-desk API listening on http://localhost:${env.PORT}`);

export default {
  port: env.PORT,
  fetch: app.fetch,
};
