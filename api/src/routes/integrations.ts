import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';
import { fetchStripeContext } from '../lib/stripe-client.ts';
import { fetchShopifyContext } from '../lib/shopify-client.ts';

export const integrations = new Hono();

integrations.use('*', requireAuth);

// ─── Slack integration (one per workspace) ──────────────────────────────
//
// Read returns the row or { integration: null } when unconfigured.
// Write is PUT (upsert) — there's only ever one row per workspace so
// "create" and "update" collapse into a single shape.

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
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');
  const { data, error } = await sb
    .from('slack_integrations')
    .select('webhook_url, channel, active, events, bot_token, signing_secret, created_at, updated_at')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ integration: null });
  // Mask the two secrets — surface only "configured yes/no" + a tail
  // suffix on the bot token (xoxb-...XXX) so the SPA can show the
  // user which token is on file without ever returning the full
  // value over the wire.
  const { bot_token, signing_secret, ...rest } = data as any;
  return c.json({
    integration: {
      ...rest,
      bot_token_suffix:       bot_token ? bot_token.slice(-6) : null,
      has_bot_token:          Boolean(bot_token),
      has_signing_secret:     Boolean(signing_secret),
    },
  });
});

integrations.put('/slack', async (c) => {
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');
  const reqBody = await c.req.json().catch(() => null);
  const parsed = SlackBody.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;
  // bot_token / signing_secret are optional. Treating `undefined` as
  // "don't touch" and `null` as "clear" lets the SPA toggle two-way
  // independently of webhook config (you can set up outbound first,
  // then add the bot token later).
  const row: any = {
    workspace_id: workspaceId,
    webhook_url:  input.webhook_url,
    channel:      input.channel ?? null,
    active:       input.active ?? true,
    events:       input.events,
  };
  if (input.bot_token !== undefined)      row.bot_token      = input.bot_token;
  if (input.signing_secret !== undefined) row.signing_secret = input.signing_secret;
  const { error } = await sb
    .from('slack_integrations')
    .upsert(row, { onConflict: 'workspace_id' });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

integrations.delete('/slack', async (c) => {
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');
  const { error } = await sb
    .from('slack_integrations')
    .delete()
    .eq('workspace_id', workspaceId);
  if (error) return c.json({ error: error.message }, 500);
  return new Response(null, { status: 204 });
});

// ─── Stripe integration ─────────────────────────────────────────────────
//
// Workspace pastes a restricted Stripe API key (read-only on customers
// + subscriptions + charges is enough). The key is the secret — never
// returned in GET responses, only used server-side. GET responds with
// just { active, has_key } so the SPA can render "Connected" without
// exposing the secret.

const StripeBody = z.object({
  api_key: z.string().regex(/^(rk|sk)_(test|live)_\w+$/, 'Must be a Stripe restricted or secret key'),
  active:  z.boolean().optional(),
});

integrations.get('/stripe', async (c) => {
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');
  const { data, error } = await sb
    .from('stripe_integrations')
    .select('api_key, active, created_at, updated_at')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ integration: null });
  return c.json({
    integration: {
      active:     data.active,
      has_key:    Boolean(data.api_key),
      // Last 4 chars only — enough to confirm "yes, the key I pasted
      // is the one stored" without leaking the rest. Stripe keys end
      // in random hex so the tail is enough to identify.
      key_suffix: data.api_key ? data.api_key.slice(-6) : null,
      mode:       data.api_key?.includes('_test_') ? 'test' : 'live',
      created_at: data.created_at,
      updated_at: data.updated_at,
    },
  });
});

integrations.put('/stripe', async (c) => {
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');
  const reqBody = await c.req.json().catch(() => null);
  const parsed = StripeBody.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const { error } = await sb
    .from('stripe_integrations')
    .upsert(
      {
        workspace_id: workspaceId,
        api_key:      parsed.data.api_key,
        active:       parsed.data.active ?? true,
      },
      { onConflict: 'workspace_id' },
    );
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

integrations.delete('/stripe', async (c) => {
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');
  const { error } = await sb
    .from('stripe_integrations')
    .delete()
    .eq('workspace_id', workspaceId);
  if (error) return c.json({ error: error.message }, 500);
  return new Response(null, { status: 204 });
});

// ─── GET /customers/:id/stripe-context — fetch Stripe data for a customer ─
//
// Looks up the workspace's Stripe key + this customer's email, then
// hits Stripe for customer + subscriptions + charges. Returns null
// blocks when the integration isn't configured OR when Stripe has no
// customer for that email (the common case). Errors from Stripe
// (auth failure, rate limit) bubble up as 502.
integrations.get('/customers/:id/stripe-context', async (c) => {
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');
  const customerId = c.req.param('id');

  const { data: integration } = await sb
    .from('stripe_integrations')
    .select('api_key, active')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (!integration || !integration.active) {
    return c.json({ configured: false, context: null });
  }

  const { data: customer } = await sb
    .from('customers')
    .select('email')
    .eq('id', customerId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .maybeSingle();
  if (!customer?.email) {
    return c.json({ configured: true, context: { customer: null, subscriptions: [], charges: [] } });
  }

  try {
    const context = await fetchStripeContext({ apiKey: integration.api_key, email: customer.email });
    return c.json({ configured: true, context });
  } catch (err) {
    console.error('[stripe] fetch failed:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Stripe lookup failed' }, 502);
  }
});

// ─── Shopify integration ────────────────────────────────────────────────
//
// Workspace provides their myshopify subdomain (e.g. "acme-store" —
// we tack on `.myshopify.com` server-side) and an Admin API access
// token. Token format is `shpat_<hex>` for custom apps; legacy
// private apps use a long hex string. We accept both. Like Stripe,
// the token never leaves the server — GET only returns a masked
// summary.

const ShopifyBody = z.object({
  shop:         z.string().regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Shop must be the myshopify subdomain (e.g. "acme-store")').max(60),
  access_token: z.string().min(20).max(200),
  active:       z.boolean().optional(),
});

integrations.get('/shopify', async (c) => {
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');
  const { data, error } = await sb
    .from('shopify_integrations')
    .select('shop, access_token, active, created_at, updated_at')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
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
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');
  const reqBody = await c.req.json().catch(() => null);
  const parsed = ShopifyBody.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  // Strip an accidentally-pasted ".myshopify.com" or full URL so we
  // only store the subdomain. The strict regex above caught most of
  // it, but users sometimes paste "acme-store.myshopify.com" hoping
  // it works — be lenient here.
  const shop = parsed.data.shop
    .replace(/^https?:\/\//, '')
    .replace(/\.myshopify\.com\/?$/, '')
    .toLowerCase();
  const { error } = await sb
    .from('shopify_integrations')
    .upsert(
      {
        workspace_id: workspaceId,
        shop,
        access_token: parsed.data.access_token,
        active:       parsed.data.active ?? true,
      },
      { onConflict: 'workspace_id' },
    );
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

integrations.delete('/shopify', async (c) => {
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');
  const { error } = await sb
    .from('shopify_integrations')
    .delete()
    .eq('workspace_id', workspaceId);
  if (error) return c.json({ error: error.message }, 500);
  return new Response(null, { status: 204 });
});

integrations.get('/customers/:id/shopify-context', async (c) => {
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');
  const customerId = c.req.param('id');

  const { data: integration } = await sb
    .from('shopify_integrations')
    .select('shop, access_token, active')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (!integration || !integration.active) {
    return c.json({ configured: false, context: null });
  }

  const { data: customer } = await sb
    .from('customers')
    .select('email')
    .eq('id', customerId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .maybeSingle();
  if (!customer?.email) {
    return c.json({ configured: true, context: { customer: null, orders: [] } });
  }

  try {
    const context = await fetchShopifyContext({
      shop:  integration.shop,
      token: integration.access_token,
      email: customer.email,
    });
    return c.json({ configured: true, context });
  } catch (err) {
    console.error('[shopify] fetch failed:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Shopify lookup failed' }, 502);
  }
});

// ─── Outgoing webhooks (multiple per workspace) ─────────────────────────
//
// Workspaces register their own HTTP endpoints to receive ticket-event
// POSTs. Distinct from Slack: that posts to chat.postMessage with our
// Slack-specific payload; this posts generic JSON to any URL with an
// HMAC signature the workspace chose. Use for CRM bridges, analytics
// pipelines, anything that wants ticket events without us hard-coding
// a transport.
//
// Secret is generated server-side on POST and never returned in any
// subsequent GET — the user copies it once at creation time.

const OUTGOING_EVENTS = ['ticket.created', 'ticket.resolved', 'ticket.escalated', 'priority.urgent'] as const;

const WebhookBody = z.object({
  name:   z.string().min(1).max(100),
  url:    z.string().url(),
  events: z.array(z.enum(OUTGOING_EVENTS)).min(1).max(OUTGOING_EVENTS.length),
  active: z.boolean().optional(),
});

integrations.get('/webhooks', async (c) => {
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');
  const { data, error } = await sb
    .from('workspace_webhooks')
    .select('id, name, url, events, active, last_delivery_at, last_delivery_status, last_delivery_error, created_at')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ webhooks: data || [] });
});

integrations.post('/webhooks', async (c) => {
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');
  const reqBody = await c.req.json().catch(() => null);
  const parsed = WebhookBody.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  // Generate the HMAC secret server-side. We surface it once on
  // create — every subsequent GET masks it. 32 bytes base64url is
  // ~43 chars, plenty for HMAC-SHA256.
  const secret = generateWebhookSecret();
  const { data, error } = await sb
    .from('workspace_webhooks')
    .insert({
      workspace_id: workspaceId,
      name:         parsed.data.name,
      url:          parsed.data.url,
      secret,
      events:       parsed.data.events,
      active:       parsed.data.active ?? true,
    })
    .select('id, name, url, events, active, created_at')
    .single();
  if (error) return c.json({ error: error.message }, 500);
  // First-and-only time the raw secret is returned. The SPA must
  // surface this to the user and warn them to store it now.
  return c.json({ webhook: data, secret }, 201);
});

integrations.delete('/webhooks/:id', async (c) => {
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');
  const { error } = await sb
    .from('workspace_webhooks')
    .delete()
    .eq('id', id)
    .eq('workspace_id', workspaceId);
  if (error) return c.json({ error: error.message }, 500);
  return new Response(null, { status: 204 });
});

// Recent delivery attempts for one webhook. Capped at 50 — enough to
// answer "is this thing working" without paginating; a future PR can
// add cursor-based scroll if real volume demands it.
integrations.get('/webhooks/:id/deliveries', async (c) => {
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');
  const { data, error } = await sb
    .from('webhook_deliveries')
    .select('id, event, attempts, state, last_status, last_error, last_attempt_at, next_attempt_at, created_at')
    .eq('webhook_id', id)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ deliveries: data || [] });
});

function generateWebhookSecret(): string {
  // 32 random bytes → base64url. Bun has crypto.randomBytes via the
  // node compat layer; use it rather than rolling our own RNG.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}
