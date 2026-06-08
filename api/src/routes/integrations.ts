import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';
import { getDb } from '../lib/db.ts';
import { fetchStripeContext } from '../lib/stripe-client.ts';
import { fetchShopifyContext } from '../lib/shopify-client.ts';

// Migration to Neon — Step 3. Member-level, workspace-scoped via getDb().
// The Stripe/Shopify clients are external HTTP (no DB) and are unchanged.
export const integrations = new Hono();

integrations.use('*', requireAuth);

// postgres.js upsert helper: insert the row, on (workspace_id) conflict update
// all of the row's columns except workspace_id. `table` is a literal union —
// only these three tables can ever be passed (no caller-supplied table names).
type IntegrationTable = 'slack_integrations' | 'stripe_integrations' | 'shopify_integrations';
function upsertByWorkspace(sql: ReturnType<typeof getDb>, table: IntegrationTable, row: Record<string, unknown>) {
  const updateKeys = Object.keys(row).filter((k) => k !== 'workspace_id');
  return sql`insert into ${sql(table)} ${sql(row)} on conflict (workspace_id) do update set ${sql(row, ...updateKeys)}`;
}

// ─── Slack integration (one per workspace) ──────────────────────────────
const EVENT_NAMES = ['ticket.created', 'ticket.resolved', 'ticket.escalated', 'priority.urgent'] as const;

const SlackBody = z.object({
  webhook_url:    z.string().url().startsWith('https://hooks.slack.com/'),
  channel:        z.string().max(80).nullable().optional(),
  active:         z.boolean().optional(),
  events:         z.array(z.enum(EVENT_NAMES)).min(1).max(EVENT_NAMES.length),
  bot_token:      z.string().regex(/^xoxb-[\w-]+$/, 'Bot token must start with xoxb-').nullable().optional(),
  signing_secret: z.string().min(16).max(200).nullable().optional(),
});

integrations.get('/slack', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const [data] = await sql`
    select webhook_url, channel, active, events, bot_token, signing_secret, created_at, updated_at
    from slack_integrations where workspace_id = ${workspaceId}
  `;
  if (!data) return c.json({ integration: null });
  const { bot_token, signing_secret, ...rest } = data;
  return c.json({
    integration: {
      ...rest,
      bot_token_suffix:   bot_token ? bot_token.slice(-6) : null,
      has_bot_token:      Boolean(bot_token),
      has_signing_secret: Boolean(signing_secret),
    },
  });
});

integrations.put('/slack', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const reqBody = await c.req.json().catch(() => null);
  const parsed = SlackBody.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  // bot_token / signing_secret: undefined = "don't touch", null = "clear".
  const row: Record<string, unknown> = {
    workspace_id: workspaceId,
    webhook_url:  input.webhook_url,
    channel:      input.channel ?? null,
    active:       input.active ?? true,
    events:       input.events,
  };
  if (input.bot_token !== undefined)      row.bot_token      = input.bot_token;
  if (input.signing_secret !== undefined) row.signing_secret = input.signing_secret;
  await upsertByWorkspace(sql, 'slack_integrations', row);
  return c.json({ ok: true });
});

integrations.delete('/slack', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  await sql`delete from slack_integrations where workspace_id = ${workspaceId}`;
  return new Response(null, { status: 204 });
});

// ─── Stripe integration ─────────────────────────────────────────────────
const StripeBody = z.object({
  api_key: z.string().regex(/^(rk|sk)_(test|live)_\w+$/, 'Must be a Stripe restricted or secret key'),
  active:  z.boolean().optional(),
});

integrations.get('/stripe', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const [data] = await sql`
    select api_key, active, created_at, updated_at from stripe_integrations where workspace_id = ${workspaceId}
  `;
  if (!data) return c.json({ integration: null });
  return c.json({
    integration: {
      active:     data.active,
      has_key:    Boolean(data.api_key),
      key_suffix: data.api_key ? data.api_key.slice(-6) : null,
      mode:       data.api_key?.includes('_test_') ? 'test' : 'live',
      created_at: data.created_at,
      updated_at: data.updated_at,
    },
  });
});

integrations.put('/stripe', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const reqBody = await c.req.json().catch(() => null);
  const parsed = StripeBody.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  await upsertByWorkspace(sql, 'stripe_integrations', {
    workspace_id: workspaceId,
    api_key:      parsed.data.api_key,
    active:       parsed.data.active ?? true,
  });
  return c.json({ ok: true });
});

integrations.delete('/stripe', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  await sql`delete from stripe_integrations where workspace_id = ${workspaceId}`;
  return new Response(null, { status: 204 });
});

// ─── GET /customers/:id/stripe-context — Stripe data for a customer ───────
integrations.get('/customers/:id/stripe-context', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const customerId = c.req.param('id');

  const [integration] = await sql`
    select api_key, active from stripe_integrations where workspace_id = ${workspaceId}
  `;
  if (!integration || !integration.active) return c.json({ configured: false, context: null });

  const [customer] = await sql`
    select email from customers where id = ${customerId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!customer?.email) return c.json({ configured: true, context: { customer: null, subscriptions: [], charges: [] } });

  try {
    const context = await fetchStripeContext({ apiKey: integration.api_key, email: customer.email });
    return c.json({ configured: true, context });
  } catch (err) {
    console.error('[stripe] fetch failed:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Stripe lookup failed' }, 502);
  }
});

// ─── Shopify integration ────────────────────────────────────────────────
const ShopifyBody = z.object({
  shop:         z.string().regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Shop must be the myshopify subdomain (e.g. "acme-store")').max(60),
  access_token: z.string().min(20).max(200),
  active:       z.boolean().optional(),
});

integrations.get('/shopify', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const [data] = await sql`
    select shop, access_token, active, created_at, updated_at from shopify_integrations where workspace_id = ${workspaceId}
  `;
  if (!data) return c.json({ integration: null });
  return c.json({
    integration: {
      shop:         data.shop,
      active:       data.active,
      has_token:    Boolean(data.access_token),
      token_suffix: data.access_token ? data.access_token.slice(-6) : null,
      created_at:   data.created_at,
      updated_at:   data.updated_at,
    },
  });
});

integrations.put('/shopify', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const reqBody = await c.req.json().catch(() => null);
  const parsed = ShopifyBody.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  const shop = parsed.data.shop
    .replace(/^https?:\/\//, '')
    .replace(/\.myshopify\.com\/?$/, '')
    .toLowerCase();
  await upsertByWorkspace(sql, 'shopify_integrations', {
    workspace_id: workspaceId,
    shop,
    access_token: parsed.data.access_token,
    active:       parsed.data.active ?? true,
  });
  return c.json({ ok: true });
});

integrations.delete('/shopify', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  await sql`delete from shopify_integrations where workspace_id = ${workspaceId}`;
  return new Response(null, { status: 204 });
});

integrations.get('/customers/:id/shopify-context', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const customerId = c.req.param('id');

  const [integration] = await sql`
    select shop, access_token, active from shopify_integrations where workspace_id = ${workspaceId}
  `;
  if (!integration || !integration.active) return c.json({ configured: false, context: null });

  const [customer] = await sql`
    select email from customers where id = ${customerId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!customer?.email) return c.json({ configured: true, context: { customer: null, orders: [] } });

  try {
    const context = await fetchShopifyContext({ shop: integration.shop, token: integration.access_token, email: customer.email });
    return c.json({ configured: true, context });
  } catch (err) {
    console.error('[shopify] fetch failed:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Shopify lookup failed' }, 502);
  }
});

// ─── Outgoing webhooks (multiple per workspace) ─────────────────────────
const OUTGOING_EVENTS = ['ticket.created', 'ticket.resolved', 'ticket.escalated', 'priority.urgent'] as const;

const WebhookBody = z.object({
  name:   z.string().min(1).max(100),
  url:    z.string().url(),
  events: z.array(z.enum(OUTGOING_EVENTS)).min(1).max(OUTGOING_EVENTS.length),
  active: z.boolean().optional(),
});

integrations.get('/webhooks', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const rows = await sql`
    select id, name, url, events, active, last_delivery_at, last_delivery_status, last_delivery_error, created_at
    from workspace_webhooks where workspace_id = ${workspaceId}
    order by created_at desc
  `;
  return c.json({ webhooks: rows });
});

integrations.post('/webhooks', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const reqBody = await c.req.json().catch(() => null);
  const parsed = WebhookBody.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);

  const secret = generateWebhookSecret();
  const [data] = await sql`
    insert into workspace_webhooks (workspace_id, name, url, secret, events, active)
    values (${workspaceId}, ${parsed.data.name}, ${parsed.data.url}, ${secret}, ${parsed.data.events}, ${parsed.data.active ?? true})
    returning id, name, url, events, active, created_at
  `;
  // First-and-only reveal of the raw secret.
  return c.json({ webhook: data, secret }, 201);
});

const PatchWebhookBody = z.object({
  name:          z.string().min(1).max(100).optional(),
  url:           z.string().url().optional(),
  events:        z.array(z.enum(OUTGOING_EVENTS)).min(1).max(OUTGOING_EVENTS.length).optional(),
  active:        z.boolean().optional(),
  rotate_secret: z.boolean().optional(),
}).strict();

integrations.patch('/webhooks/:id', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PatchWebhookBody.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  const { rotate_secret, ...fields } = parsed.data;
  if (Object.keys(fields).length === 0 && !rotate_secret) return c.json({ error: 'No fields to update' }, 400);

  const updates: Record<string, unknown> = { ...fields };
  let revealedSecret: string | null = null;
  if (rotate_secret) {
    revealedSecret = generateWebhookSecret();
    updates.secret = revealedSecret;
  }

  const [data] = await sql`
    update workspace_webhooks set ${sql(updates)}
    where id = ${id} and workspace_id = ${workspaceId}
    returning id, name, url, events, active, last_delivery_at, last_delivery_status, last_delivery_error, created_at
  `;
  if (!data) return c.json({ error: 'Webhook not found' }, 404);
  return c.json(revealedSecret ? { webhook: data, secret: revealedSecret } : { webhook: data });
});

integrations.delete('/webhooks/:id', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');
  await sql`delete from workspace_webhooks where id = ${id} and workspace_id = ${workspaceId}`;
  return new Response(null, { status: 204 });
});

integrations.get('/webhooks/:id/deliveries', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');
  const rows = await sql`
    select id, event, attempts, state, last_status, last_error, last_attempt_at, next_attempt_at, created_at
    from webhook_deliveries
    where webhook_id = ${id} and workspace_id = ${workspaceId}
    order by created_at desc
    limit 50
  `;
  return c.json({ deliveries: rows });
});

integrations.post('/webhooks/:id/deliveries/:deliveryId/retry', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const webhookId = c.req.param('id');
  const deliveryId = c.req.param('deliveryId');

  const [existing] = await sql`
    select id, state from webhook_deliveries
    where id = ${deliveryId} and webhook_id = ${webhookId} and workspace_id = ${workspaceId}
  `;
  if (!existing) return c.json({ error: 'Delivery not found' }, 404);
  if (existing.state !== 'exhausted') {
    return c.json({ error: `Only exhausted deliveries can be re-queued; this one is ${existing.state}` }, 409);
  }

  await sql`
    update webhook_deliveries
    set state = 'pending', attempts = 0, next_attempt_at = now(), last_status = null, last_error = null
    where id = ${deliveryId}
  `;
  return c.json({ ok: true });
});

// ─── Postmark suppression list ──────────────────────────────────────────
integrations.get('/postmark/suppressed', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const rows = await sql`
    select id, display_id, first_name, last_name, email, email_bounce_state, email_last_bounce_type, email_last_bounce_at, email_bounce_count
    from customers
    where workspace_id = ${workspaceId} and email_bounce_state in ('hard', 'spam') and deleted_at is null
    order by email_last_bounce_at desc
    limit 200
  `;
  return c.json({ suppressed: rows });
});

integrations.post('/postmark/suppressed/:customerId/reset', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const customerId = c.req.param('customerId');

  const [data] = await sql`
    update customers
    set email_bounce_state = 'none', email_last_bounce_type = null, email_last_bounce_at = null, email_bounce_count = 0
    where id = ${customerId} and workspace_id = ${workspaceId} and deleted_at is null
    returning id, email_bounce_state
  `;
  if (!data) return c.json({ error: 'Customer not found' }, 404);
  return c.json({ ok: true, customer: data });
});

function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}
