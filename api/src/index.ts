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
import { god } from './routes/god.ts';
import { whoami } from './routes/whoami.ts';
import { config } from './routes/config.ts';
import { customers } from './routes/customers.ts';
import { agents } from './routes/agents.ts';
import { inbox } from './routes/inbox.ts';
import { channels } from './routes/channels.ts';
import { workflows } from './routes/workflows.ts';
import { slaPolicies } from './routes/sla-policies.ts';
import { tags } from './routes/tags.ts';
import { kb } from './routes/kb.ts';

const app = new Hono();

app.use('*', logger());
app.use('*', cors({
  origin: '*',  // Tighten before exposing publicly. For local dev, * is fine.
  allowHeaders: ['Authorization', 'Content-Type', 'X-Workspace-Id'],
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
}));

app.route('/api/v1/health', health);
app.route('/api/v1/config', config);
app.route('/api/v1/me', me);
app.route('/api/v1/whoami', whoami);
app.route('/api/v1/tickets', tickets);
app.route('/api/v1/tickets/:id/triage', triage);
app.route('/api/v1/customers', customers);
app.route('/api/v1/agents', agents);
app.route('/api/v1/inbox', inbox);
app.route('/api/v1/channels', channels);
app.route('/api/v1/workflows', workflows);
app.route('/api/v1/sla-policies', slaPolicies);
app.route('/api/v1/tags', tags);
app.route('/api/v1/kb-articles', kb);
app.route('/api/v1/webhooks', webhooks);
app.route('/api/v1/god', god);

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
