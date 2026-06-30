import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import { getDb } from '../lib/db.js';
import { nextDisplayId } from '../lib/display-id.js';
import { enforceRateLimit } from '../lib/rate-limit.js';
import { suggestKbForQuestion } from '../lib/kb-suggest.js';
import { createMagicLink, verifyMagicLink, customerForSession } from '../lib/portal-auth.js';
import { sendEmail, PostmarkSendError } from '../lib/postmark-outbound.js';
import { getOutboundFrom } from '../lib/outbound-from.js';
import { composeEmail } from '../lib/email-branding.js';
import { verifyUnsubscribeToken } from '../lib/unsubscribe.js';
import { env, isLocalDev } from '../lib/env.js';

export const publicRoutes = new Hono();

// Migration to Neon — Step 3 (portal batch). All data access uses getDb()
// raw SQL, scoped by the workspace resolved from the URL slug.

// No requireAuth — these endpoints are by design unauth. Workspace
// identified by URL slug. Avoids leaking data: every handler scopes by
// the resolved workspace_id, never the caller.

interface ResolvedWorkspace {
  id:            string;
  name:          string;
  slug:          string;
  primary_color: string | null;
  logo_url:      string | null;
}

async function resolveWorkspace(slug: string): Promise<ResolvedWorkspace> {
  const sql = getDb();
  const [data] = await sql<{
    id: string; name: string; slug: string; primary_color: string | null; logo_url: string | null;
    suspended_at: string | null; is_unrouted_bucket: boolean | null; deleted_at: string | null;
  }[]>`
    select id, name, slug, primary_color, logo_url, suspended_at, is_unrouted_bucket, deleted_at
    from workspaces where slug = ${slug}
  `;
  if (!data || data.deleted_at || data.is_unrouted_bucket) {
    throw new HTTPException(404, { message: 'Workspace not found' });
  }
  if (data.suspended_at) throw new HTTPException(403, { message: 'Workspace is suspended' });
  return { id: data.id, name: data.name, slug: data.slug, primary_color: data.primary_color, logo_url: data.logo_url };
}

// GET /api/v1/public/resolve-host?host=help.acme.com — returns the
// workspace slug for a verified custom domain. The portal calls this
// at boot when no ?ws= param is present, so a CNAMEd custom host
// can serve maestro's portal.html with no client-side wiring beyond
// reading window.location.host.
publicRoutes.get('/resolve-host', async (c) => {
  const host = (c.req.query('host') || '').trim().toLowerCase();
  if (!host) return c.json({ error: 'host query param required' }, 400);
  const sql = getDb();
  const [data] = await sql<{ slug: string }[]>`
    select slug from workspaces
    where portal_custom_domain = ${host} and portal_custom_domain_verified = true and deleted_at is null
  `;
  if (!data) return c.json({ slug: null }, 404);
  return c.json({ slug: data.slug });
});

// ─── GET /:slug/config — workspace name + branding ───────────────────────
publicRoutes.get('/:slug/config', async (c) => {
  const ws = await resolveWorkspace(c.req.param('slug'));
  const sql = getDb();
  // Portal copy lives on workspaces.* — resolveWorkspace's narrow
  // select doesn't carry them, so re-fetch the three optional fields
  // here. Single extra round-trip per portal boot, negligible.
  const [copy] = await sql<{ portal_tagline: string | null; portal_intro: string | null; portal_footer: string | null }[]>`
    select portal_tagline, portal_intro, portal_footer from workspaces where id = ${ws.id}
  `;
  return c.json({
    workspace: {
      slug:           ws.slug,
      name:           ws.name,
      primary_color:  ws.primary_color || null,
      logo_url:       ws.logo_url || null,
      portal_tagline: copy?.portal_tagline || null,
      portal_intro:   copy?.portal_intro   || null,
      portal_footer:  copy?.portal_footer  || null,
    },
  });
});

// ─── GET /:slug/kb-articles — published articles ─────────────────────────
//
// Strips agent-only fields. No author identification, no draft / archived
// content. Status is filtered server-side so a misconfigured client can't
// scrape unpublished work.
publicRoutes.get('/:slug/kb-articles', async (c) => {
  const ws = await resolveWorkspace(c.req.param('slug'));
  const sql = getDb();
  const articles = await sql`
    select id, display_id, title, category, body, view_count, helpful_count, unhelpful_count, updated_at
    from kb_articles
    where workspace_id = ${ws.id} and status = 'published'
    order by updated_at desc
  `;
  return c.json({ articles });
});

// ─── POST /:slug/tickets — public ticket submission ──────────────────────
//
// Match-or-create the customer by email (stub fields from name) — same
// shape as the Postmark inbound path. Insert the ticket + first message,
// fire auto-assign rules so the new ticket lands on someone's queue.
// Auto-triage is the agent's next step.
const PublicTicket = z.object({
  name:    z.string().min(1).max(200),
  email:   z.string().email().max(320),
  subject: z.string().min(1).max(500),
  body:    z.string().min(1).max(20000),
});

publicRoutes.post('/:slug/tickets', async (c) => {
  const limited = await enforceRateLimit(c, { name: 'portal-ticket', max: 10, windowSeconds: 600 });
  if (limited) return limited;
  const ws = await resolveWorkspace(c.req.param('slug'));
  const sql = getDb();

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PublicTicket.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;
  const email = input.email.toLowerCase();

  // Match-or-create customer.
  let customerId: string;
  const [existing] = await sql<{ id: string }[]>`
    select id from customers
    where workspace_id = ${ws.id} and email = ${email} and deleted_at is null
  `;

  if (existing) {
    customerId = existing.id;
  } else {
    const [first, ...rest] = input.name.trim().split(/\s+/);
    const last = rest.join(' ') || null;
    try {
      const custDisplayId = await nextDisplayId(sql, ws.id, 'customer');
      const [created] = await sql<{ id: string }[]>`
        insert into customers (workspace_id, display_id, first_name, last_name, email)
        values (${ws.id}, ${custDisplayId}, ${first}, ${last}, ${email})
        returning id
      `;
      customerId = created.id;
    } catch (err: any) {
      // Race recovery — same shape as the Postmark inbound handler.
      if (err?.code === '23505') {
        const [winner] = await sql<{ id: string }[]>`
          select id from customers where workspace_id = ${ws.id} and email = ${email}
        `;
        if (!winner) return c.json({ error: 'Customer race recovery failed' }, 500);
        customerId = winner.id;
      } else {
        throw err;
      }
    }
  }

  // Create the ticket + its first message atomically. A bare ticket with
  // no opening message is a broken record (the agent view would render an
  // empty thread), so they land together or not at all — if the message
  // insert throws, the ticket insert rolls back and the request surfaces a
  // clean 500 via the global error handler with nothing orphaned.
  const ticket = await sql.begin(async (tx) => {
    const ticketDisplayId = await nextDisplayId(tx, ws.id, 'ticket');
    const [t] = await tx<{ id: string; display_id: string }[]>`
      insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key, sla_state)
      values (${ws.id}, ${ticketDisplayId}, ${input.subject}, ${customerId}, 'open', 'normal', 'ok')
      returning id, display_id
    `;
    // First message — author_label uses the customer's submitted name.
    await tx`
      insert into ticket_messages (workspace_id, ticket_id, role, author_label, body)
      values (${ws.id}, ${t.id}, 'customer', ${input.name}, ${input.body})
    `;
    return t;
  }) as { id: string; display_id: string };

  // Audit row so the agent UI can show "submitted via portal" if it ever
  // cares about the channel. Best-effort: the ticket is already committed,
  // so an audit-log hiccup must not fail an otherwise-successful submission.
  try {
    await sql`
      insert into audit_events (workspace_id, action, target_type, target_id, metadata)
      values (${ws.id}, 'portal.ticket_submitted', 'ticket', ${ticket.id},
              ${sql.json({ customer_id: customerId, from_email: email, from_name: input.name })})
    `;
  } catch (err) {
    console.warn('[public] portal.ticket_submitted audit insert failed:', err instanceof Error ? err.message : err);
  }

  return c.json({
    ticket: { id: ticket.id, display_id: ticket.display_id },
    customer: { id: customerId },
  }, 201);
});

// ─── POST /:slug/kb-suggest — AI-rank KB articles for a question ─────────
//
// The portal calls this after the customer fills in subject + body to
// suggest articles that might let them self-serve. Returns
// { suggestions: [{ article_id, confidence, reason }] } — display_ids
// matching the workspace's KB. Empty list when no good match OR when
// the workspace's AI budget is exhausted (graceful degrade — portal
// just shows "submit a request" without the suggestions panel).
const PostSuggest = z.object({
  question: z.string().min(8).max(4000),
});

publicRoutes.post('/:slug/kb-suggest', async (c) => {
  // Each call is an LLM request — rate-limit per IP to cap cost abuse.
  // Fail CLOSED: a DB outage must not open the door to unbounded LLM spend.
  const limited = await enforceRateLimit(c, { name: 'portal-kb-suggest', max: 20, windowSeconds: 600, failClosed: true });
  if (limited) return limited;
  const ws = await resolveWorkspace(c.req.param('slug'));

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PostSuggest.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }

  try {
    const res = await suggestKbForQuestion({
      workspaceId: ws.id,
      question:    parsed.data.question,
    });
    return c.json({ suggestions: res.suggestions });
  } catch (err) {
    console.error('[public] kb-suggest failed:', err);
    // Don't surface the error to the customer — they'll just submit
    // their ticket without suggestions, which is the correct fallback.
    return c.json({ suggestions: [] });
  }
});

// ─── POST /:slug/auth/request — start magic-link login ─────────────────
//
// Always returns 200 with a generic message regardless of whether the
// email matches a customer — avoids leaking customer presence. If a
// match exists, generate a magic link and email it. Email failures are
// logged but the response stays the same.
const PostAuthRequest = z.object({
  email:     z.string().email().max(320),
  return_to: z.string().max(500).optional(),  // optional client-supplied return URL
});

publicRoutes.post('/:slug/auth/request', async (c) => {
  // Per-IP cap on magic-link requests (each can send an email).
  // Fail CLOSED: a DB outage must not open the door to unbounded email sends.
  const ipLimited = await enforceRateLimit(c, { name: 'portal-auth-request', max: 5, windowSeconds: 900, failClosed: true });
  if (ipLimited) return ipLimited;

  const ws = await resolveWorkspace(c.req.param('slug'));
  const sql = getDb();

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PostAuthRequest.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const email = parsed.data.email.toLowerCase();

  // Also cap per target email so one address can't be mail-bombed from many IPs.
  const emailLimited = await enforceRateLimit(c, { name: 'portal-auth-request-email', by: email, max: 5, windowSeconds: 900, failClosed: true });
  if (emailLimited) return emailLimited;

  const [customer] = await sql<{ id: string; first_name: string | null }[]>`
    select id, first_name from customers
    where workspace_id = ${ws.id} and email = ${email} and deleted_at is null
  `;

  const genericOk = { ok: true, message: 'If that email is on file, a sign-in link is on the way.' };
  if (!customer) return c.json(genericOk);

  let token: string;
  try {
    const link = await createMagicLink({ workspaceId: ws.id, customerId: customer.id });
    token = link.token;
  } catch (err) {
    console.error('[portal-auth] createMagicLink failed:', err);
    return c.json(genericOk);
  }

  // Build the link the customer will click. Precedence:
  //   1. Client-passed return_to (the portal posting from its own host)
  //   2. PORTAL_BASE_URL env var (production-configured portal)
  //   3. API request origin + /portal.html (dev fallback)
  // The magic token rides in the query string regardless.
  const portalBase = parsed.data.return_to
    || (env.PORTAL_BASE_URL ? `${env.PORTAL_BASE_URL}?ws=${ws.slug}` : null)
    || `${new URL(c.req.url).origin.replace(/\/$/, '')}/portal.html?ws=${ws.slug}`;
  const base = portalBase;
  const sep = base.includes('?') ? '&' : '?';
  const url = `${base}${sep}token=${token}`;

  // Logging policy: the magic-link URL carries a live auth token and the
  // email is customer PII — neither may reach production logs (they're
  // retained by the platform). Only in local dev do we print the full link,
  // so first-run setups can copy it from the console when Postmark isn't
  // configured. Anywhere production-like (Vercel or NODE_ENV=production) we
  // log only non-sensitive identifiers for traceability — see isLocalDev,
  // which fails safe so a non-Vercel production env still redacts.
  if (isLocalDev) {
    console.log(`[portal-auth] magic link for ${email}: ${url}`);
  } else {
    console.log(`[portal-auth] magic link issued for customer ${customer.id} (ws ${ws.slug})`);
  }

  // Best-effort email send. If POSTMARK_SERVER_TOKEN isn't set OR the
  // workspace has no verified domain, the call throws — we log + swallow
  // so the customer-facing response stays consistent.
  try {
    const from = await getOutboundFrom(ws.id);
    if (from) {
      const textBody = `Hi${customer.first_name ? ' ' + customer.first_name : ''},

You requested a sign-in link for ${ws.name}. Click below to view your tickets:

${url}

This link expires in 15 minutes. If you didn't request it, you can ignore this email.`;
      // Brand with the workspace's default header/footer (no author signature).
      const composed = await composeEmail({ workspaceId: ws.id, bodyText: textBody });
      await sendEmail({
        to:        email,
        subject:   `Sign in to ${ws.name}`,
        textBody:  composed.text,
        htmlBody:  composed.html,
        fromEmail: from.fromEmail,
        fromName:  from.fromName,
      });
    }
  } catch (err) {
    if (err instanceof PostmarkSendError) {
      console.warn('[portal-auth] postmark send failed:', err.message);
    } else {
      console.warn('[portal-auth] email send failed:', err);
    }
  }

  return c.json(genericOk);
});

// ─── POST /:slug/auth/verify — exchange magic link for a session ───────
const PostAuthVerify = z.object({
  token: z.string().min(32).max(128),
});

publicRoutes.post('/:slug/auth/verify', async (c) => {
  // Cap token-guessing attempts per IP (tokens are already 32+ random chars).
  const limited = await enforceRateLimit(c, { name: 'portal-auth-verify', max: 20, windowSeconds: 900 });
  if (limited) return limited;
  const ws = await resolveWorkspace(c.req.param('slug'));
  const sql = getDb();

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PostAuthVerify.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }

  const result = await verifyMagicLink({
    workspaceId: ws.id,
    token:       parsed.data.token,
  });
  if (!result) return c.json({ error: 'Link is invalid or expired' }, 401);

  // Return the customer's basic info alongside the session so the portal
  // can greet them by name without a second round-trip.
  const [customer] = await sql<{ id: string; display_id: string; first_name: string | null; last_name: string | null; email: string | null }[]>`
    select id, display_id, first_name, last_name, email from customers where id = ${result.customerId}
  `;

  return c.json({
    session_token: result.sessionToken,
    customer: customer
      ? {
          id:         customer.id,
          display_id: customer.display_id,
          name:       `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || customer.email,
          email:      customer.email,
        }
      : { id: result.customerId },
  });
});

// ─── Session middleware — used by /customer/* routes below ─────────────
//
// Sub-app middleware that resolves the bearer token to a customer.
// Mounted as a chained handler before each customer route. Strips the
// session lookup boilerplate from the handlers themselves.
async function withCustomer(c: any, workspaceId: string) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const sessionToken = authHeader.slice('Bearer '.length);
  return customerForSession({ workspaceId, sessionToken });
}

// ─── GET /:slug/customer/tickets — list this customer's tickets ────────
publicRoutes.get('/:slug/customer/tickets', async (c) => {
  const ws = await resolveWorkspace(c.req.param('slug'));
  const sess = await withCustomer(c, ws.id);
  if (!sess) return c.json({ error: 'Sign in to view your tickets' }, 401);

  const sql = getDb();
  const tickets = await sql`
    select id, display_id, subject, status_key, priority_key, created_at, updated_at
    from tickets
    where workspace_id = ${ws.id} and customer_id = ${sess.customerId} and deleted_at is null
    order by updated_at desc
  `;
  return c.json({ tickets });
});

// ─── GET /:slug/customer/tickets/:displayId — single ticket + messages ─
publicRoutes.get('/:slug/customer/tickets/:displayId', async (c) => {
  const ws = await resolveWorkspace(c.req.param('slug'));
  const sess = await withCustomer(c, ws.id);
  if (!sess) return c.json({ error: 'Sign in to view your tickets' }, 401);

  const sql = getDb();
  const displayId = c.req.param('displayId');
  const [ticket] = await sql<{ id: string; display_id: string; subject: string; status_key: string; priority_key: string | null; created_at: string; updated_at: string }[]>`
    select id, display_id, subject, status_key, priority_key, created_at, updated_at
    from tickets
    where workspace_id = ${ws.id} and display_id = ${displayId}
      and customer_id = ${sess.customerId}  -- scope: must be their ticket
      and deleted_at is null
  `;
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

  // Strip internal notes — those are agent-private.
  const messages = await sql`
    select id, role, author_label, body, created_at
    from ticket_messages
    where ticket_id = ${ticket.id} and role in ('customer', 'agent', 'ai') and deleted_at is null
    order by created_at asc
  `;

  return c.json({ ticket: { ...ticket, messages } });
});

// ─── POST /:slug/customer/tickets/:displayId/messages — customer reply ─
const PostCustomerReply = z.object({
  body: z.string().min(1).max(20000),
});

publicRoutes.post('/:slug/customer/tickets/:displayId/messages', async (c) => {
  const ws = await resolveWorkspace(c.req.param('slug'));
  const sess = await withCustomer(c, ws.id);
  if (!sess) return c.json({ error: 'Sign in to reply' }, 401);

  // Cap reply volume so a valid session can't flood a thread.
  const limited = await enforceRateLimit(c, { name: 'portal-reply', max: 30, windowSeconds: 600 });
  if (limited) return limited;

  const sql = getDb();
  const reqBody = await c.req.json().catch(() => null);
  const parsed = PostCustomerReply.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }

  const displayId = c.req.param('displayId');
  const [ticket] = await sql<{ id: string; status_key: string }[]>`
    select id, status_key from tickets
    where workspace_id = ${ws.id} and display_id = ${displayId}
      and customer_id = ${sess.customerId} and deleted_at is null
  `;
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

  // Fetch the customer's name for the author_label so the thread renders
  // identically to messages that came in via Postmark inbound.
  const [customer] = await sql<{ first_name: string | null; last_name: string | null; email: string | null }[]>`
    select first_name, last_name, email from customers where id = ${sess.customerId}
  `;
  const authorLabel = customer
    ? `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || customer.email || 'Customer'
    : 'Customer';

  const [message] = await sql`
    insert into ticket_messages (workspace_id, ticket_id, role, author_label, body)
    values (${ws.id}, ${ticket.id}, 'customer', ${authorLabel}, ${parsed.data.body})
    returning id, role, author_label, body, created_at
  `;

  // Customer reply un-resolves the ticket so agents see it back in the
  // open queue. Mirrors the normal inbound-email behaviour.
  if (ticket.status_key === 'resolved') {
    await sql`update tickets set status_key = 'open' where id = ${ticket.id} and workspace_id = ${ws.id}`;
  }

  return c.json({ message }, 201);
});

// ─── CSAT survey: token-gated, no portal session needed ──────────────────
//
// The customer reaches this through a link in the auto-survey email; we
// don't ask them to sign in (the link is itself the proof). GET returns
// the minimal ticket context; POST records the rating + optional comment.
// Either endpoint 404s for unknown tokens, tokens older than the TTL
// (expiry), and tokens cleared after submission (rotation) — so a leaked
// link is not a permanent unauthenticated read of customer data (#12).
const CSAT_TOKEN_TTL_DAYS = 30;

publicRoutes.get('/:slug/csat/:token', async (c) => {
  const limited = await enforceRateLimit(c, { name: 'portal-csat', max: 30, windowSeconds: 600 });
  if (limited) return limited;

  const ws = await resolveWorkspace(c.req.param('slug'));
  const sql = getDb();
  const token = c.req.param('token');
  // Expired tokens 404 like unknown ones — a leaked survey link must not be a
  // permanent unauthenticated read of customer name + subject (#12).
  const [ticket] = await sql<{ display_id: string; subject: string; csat_score: number | null; csat_submitted_at: string | null; customer_first_name: string | null }[]>`
    select t.display_id, t.subject, t.csat_score, t.csat_submitted_at, c.first_name as customer_first_name
    from tickets t left join customers c on c.id = t.customer_id
    where t.workspace_id = ${ws.id} and t.csat_token = ${token} and t.deleted_at is null
      and t.csat_requested_at > now() - make_interval(days => ${CSAT_TOKEN_TTL_DAYS})
  `;
  if (!ticket) throw new HTTPException(404, { message: 'Survey not found' });
  return c.json({
    workspace: { name: ws.name, slug: ws.slug, primary_color: ws.primary_color, logo_url: ws.logo_url },
    ticket: {
      display_id:    ticket.display_id,
      subject:       ticket.subject,
      customer_name: ticket.customer_first_name || null,
      submitted_at:  ticket.csat_submitted_at,
      score:         ticket.csat_score,
    },
  });
});

const CsatSubmit = z.object({
  score:   z.number().int().min(1).max(5),
  comment: z.string().max(2000).nullable().optional(),
});

publicRoutes.post('/:slug/csat/:token', async (c) => {
  const limited = await enforceRateLimit(c, { name: 'portal-csat', max: 30, windowSeconds: 600 });
  if (limited) return limited;

  const ws = await resolveWorkspace(c.req.param('slug'));
  const sql = getDb();
  const token = c.req.param('token');
  const reqBody = await c.req.json().catch(() => null);
  const parsed = CsatSubmit.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }

  // Refuse to overwrite a submitted rating — the survey is one-shot,
  // matches what the SPA's manual rating flow does.
  const [ticket] = await sql<{ id: string; csat_submitted_at: string | null }[]>`
    select id, csat_submitted_at from tickets
    where workspace_id = ${ws.id} and csat_token = ${token} and deleted_at is null
      and csat_requested_at > now() - make_interval(days => ${CSAT_TOKEN_TTL_DAYS})
  `;
  if (!ticket) throw new HTTPException(404, { message: 'Survey not found' });
  if (ticket.csat_submitted_at) {
    return c.json({ error: 'Survey already submitted' }, 409);
  }

  // Record the rating and clear the token: the survey is one-shot, and nulling
  // the token stops the link from returning customer data after submission (#12).
  await sql`
    update tickets set
      csat_score        = ${parsed.data.score},
      csat_stars        = ${parsed.data.score},
      csat_comment      = ${parsed.data.comment || null},
      csat_submitted_at = now(),
      csat_token        = null
    where id = ${ticket.id} and workspace_id = ${ws.id}
  `;

  return c.json({ ok: true });
});

// ─── Unsubscribe — honour an opt-out from a customer email ────────────────
// Linked from outbound customer email (CSAT) via a stateless signed token.
// GET = the human clicks the link → set consent=false + show a confirmation.
// POST = RFC 8058 one-click (List-Unsubscribe-Post) → same effect, JSON reply.
// The token is bound to the workspace, so a token for one brand can't
// unsubscribe a customer in another. Always 200 on a valid token (idempotent).
const HTML_ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

type UnsubResult = { ok: true; name: string } | { ok: false; res: Response };

async function applyUnsubscribe(c: Context): Promise<UnsubResult> {
  const ws = await resolveWorkspace(c.req.param('slug') ?? '');
  const token = c.req.query('u') || '';
  const customerId = token ? verifyUnsubscribeToken(ws.id, token) : null;
  if (!customerId) return { ok: false, res: c.json({ error: 'This unsubscribe link is invalid or has expired.' }, 400) };
  const sql = getDb();
  await sql`
    update customers set consent = false
    where id = ${customerId} and workspace_id = ${ws.id}
  `;
  return { ok: true, name: ws.name };
}

publicRoutes.post('/:slug/unsubscribe', async (c) => {
  // RFC 8058 one-click: the mail client POSTs `List-Unsubscribe=One-Click` as
  // a form body. Require it so a bare cross-site/crawler POST can't trigger an
  // unsubscribe off a guessed URL (the token is the real auth; this is defence
  // in depth + RFC alignment).
  const form: Record<string, unknown> = await c.req.parseBody().catch(() => ({}));
  if (form['List-Unsubscribe'] !== 'One-Click') {
    return c.json({ error: 'Expected List-Unsubscribe=One-Click' }, 400);
  }
  const r = await applyUnsubscribe(c);
  if (!r.ok) return r.res;
  return c.json({ unsubscribed: true });
});

publicRoutes.get('/:slug/unsubscribe', async (c) => {
  const r = await applyUnsubscribe(c);
  if (!r.ok) return r.res;
  const name = r.name.replace(/[&<>"]/g, (ch) => HTML_ESCAPE[ch] ?? ch);
  return c.html(
    `<!doctype html><meta charset="utf8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Unsubscribed</title>` +
    `<div style="font:16px/1.5 system-ui,sans-serif;max-width:460px;margin:80px auto;padding:0 24px;text-align:center;color:#1a1a2e">` +
    `<h1 style="font-size:20px;margin:0 0 12px">You're unsubscribed</h1>` +
    `<p style="color:#555">You won't receive further survey or notification emails from ${name}. ` +
    `You'll still get replies to support tickets you contact us about.</p></div>`,
  );
});
