// Sentry must initialise before anything else loads. DSN-gated, so this is a
// no-op until SENTRY_DSN is set (see lib/instrument.ts).
import { captureException, flushSentry } from './lib/instrument.js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { HTTPException } from 'hono/http-exception';
import { env } from './lib/env.js';
import { auth } from './lib/auth.js';
import { health } from './routes/health.js';
import { me } from './routes/me.js';
import { workspace } from './routes/workspace.js';
import { savedSearches } from './routes/saved-searches.js';
import { tickets } from './routes/tickets.js';
import { triage } from './routes/triage.js';
import { webhooks } from './routes/webhooks.js';
import { god } from './routes/god.js';
import { maestro } from './routes/maestro.js';
import { whoami } from './routes/whoami.js';
import { customers } from './routes/customers.js';
import { agents } from './routes/agents.js';
import { inbox } from './routes/inbox.js';
import { channels } from './routes/channels.js';
import { slaPolicies } from './routes/sla-policies.js';
import { tags } from './routes/tags.js';
import { kb } from './routes/kb.js';
import { cannedResponses } from './routes/canned-responses.js';
import { ticketTemplates } from './routes/ticket-templates.js';
import { customFields } from './routes/custom-fields.js';
import { assignRules } from './routes/assign-rules.js';
import { roles } from './routes/roles.js';
import { customValues } from './routes/custom-values.js';
import { publicRoutes } from './routes/public.js';
import { integrations } from './routes/integrations.js';
import { presence } from './routes/presence.js';
import { categories } from './routes/categories.js';
import { pubby } from './routes/pubby.js';
import { cron } from './routes/cron.js';

const app = new Hono();

// Browser origins allowed to call the AUTHENTICATED agent API + /api/auth/*.
// The agent SPA is served from APP_BASE_URL (https://desk.maestro-desk.com in
// prod, http://localhost:5173 in dev). Vercel PR previews are deliberately NOT
// allowed: index.html only points desk./help. at the deployed API, so a preview
// SPA targets localhost:3001 and never calls the deployed API cross-origin.
// Note this is defense-in-depth, not the auth boundary — the SPA authenticates
// with bearer tokens in sessionStorage, not ambient cookies, so a cross-origin
// page can't replay credentials regardless. Better Auth's own trustedOrigins
// (lib/auth.ts) separately guards /api/auth/*.
const AGENT_ORIGINS = [env.APP_BASE_URL, 'http://localhost:5173'];

// A request gets the OPEN CORS policy only when its path unambiguously lives
// under /api/v1/public/. We decode once and reject any '..' (or an undecodable
// path) so an encoded-slash trick like `/api/v1/public/..%2Ftickets` — which
// keeps the literal prefix but isn't really a public route — can't smuggle a
// request into the open branch. Anything ambiguous falls through to the locked
// allowlist, which is the safe default.
function isPublicApiPath(rawPath: string): boolean {
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return false;
  }
  if (path.includes('..')) return false;
  return path.startsWith('/api/v1/public/');
}

app.use('*', logger());
app.use('*', cors({
  origin: (origin, c) => {
    // Public/portal API is intentionally open: it's unauthenticated and is
    // embedded on arbitrary verified white-label brand domains (resolved via
    // workspaces.portal_custom_domain), which we can't enumerate ahead of time.
    if (isPublicApiPath(c.req.path)) return origin || '*';
    // Authenticated agent API + auth: reflect only allowlisted origins; an
    // empty return omits Access-Control-Allow-Origin so the browser blocks it.
    return AGENT_ORIGINS.includes(origin) ? origin : '';
  },
  allowHeaders: ['Authorization', 'Content-Type', 'X-Workspace-Id', 'X-Brand-Id'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// Better Auth handler (migration to Neon — Step 2). Serves sign-in, session,
// and account endpoints under /api/auth/*. Mounted before the v1 routes; the
// v1 auth middleware will verify Better Auth sessions once the cutover lands.
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

app.route('/api/v1/health', health);
app.route('/api/v1/me', me);
app.route('/api/v1/workspace', workspace);
app.route('/api/v1/saved-searches', savedSearches);
app.route('/api/v1/whoami', whoami);
app.route('/api/v1/tickets', tickets);
app.route('/api/v1/tickets/:id/triage', triage);
app.route('/api/v1/customers', customers);
app.route('/api/v1/agents', agents);
app.route('/api/v1/inbox', inbox);
app.route('/api/v1/channels', channels);
app.route('/api/v1/sla-policies', slaPolicies);
app.route('/api/v1/tags', tags);
app.route('/api/v1/categories', categories);
app.route('/api/v1/kb-articles', kb);
app.route('/api/v1/canned-responses', cannedResponses);
app.route('/api/v1/ticket-templates', ticketTemplates);
app.route('/api/v1/custom-fields', customFields);
app.route('/api/v1/assign-rules', assignRules);
app.route('/api/v1/roles', roles);
app.route('/api/v1/custom-values', customValues);
app.route('/api/v1/public', publicRoutes);
app.route('/api/v1/integrations', integrations);
app.route('/api/v1/presence', presence);
app.route('/api/v1/pubby', pubby);
app.route('/api/v1/cron', cron);
app.route('/api/v1/webhooks', webhooks);
app.route('/api/v1/god', god);
app.route('/api/v1/maestro', maestro);

app.onError(async (err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();   // expected 4xx — not an incident, never reported
  }
  // Report the unhandled error to Sentry (no-op when the DSN is unset), then
  // log it server-side. The DB error text (table/column/constraint names) is
  // an information-leak vector, so it stays in the log, not the response.
  captureException(err, { path: c.req.path, method: c.req.method });
  console.error('Unhandled error:', err);
  // Flush before the serverless function can freeze, so the event isn't lost.
  await flushSentry();
  return c.json({ error: 'Internal server error' }, 500);
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

// Hosting (Step 6): export the Hono app as the default. Vercel auto-detects
// this (`src/index.ts` + `export default app`) and turns the routes into
// serverless functions — no Bun.serve, no always-on process. The background
// workers do NOT run here: on Vercel they're driven by Vercel Cron
// (routes/cron.ts) + inline delivery (lib/outgoing-webhooks waitUntil); for
// local Bun dev, src/dev.ts wraps this app in Bun.serve and starts the
// in-process workers.
export default app;
