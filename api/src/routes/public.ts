import { Hono } from 'hono';
import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import { supabaseAdmin } from '../lib/supabase.ts';
import { suggestKbForQuestion } from '../lib/kb-suggest.ts';
import { createMagicLink, verifyMagicLink, customerForSession } from '../lib/portal-auth.ts';
import { sendEmail, PostmarkSendError } from '../lib/postmark-outbound.ts';
import { getOutboundFrom } from '../lib/outbound-from.ts';
import { env } from '../lib/env.ts';

export const publicRoutes = new Hono();

// No requireAuth — these endpoints are by design unauth. Workspace
// identified by URL slug. Avoids leaking data: every handler scopes by
// the resolved workspace_id, never the caller.

async function resolveWorkspace(slug: string) {
  const { data, error } = await supabaseAdmin
    .from('workspaces')
    .select('id, name, slug, primary_color, logo_url, suspended_at, is_unrouted_bucket, deleted_at')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw new HTTPException(500, { message: error.message });
  if (!data || data.deleted_at || data.is_unrouted_bucket) {
    throw new HTTPException(404, { message: 'Workspace not found' });
  }
  if (data.suspended_at) throw new HTTPException(403, { message: 'Workspace is suspended' });
  return data;
}

// ─── GET /:slug/config — workspace name + branding ───────────────────────
publicRoutes.get('/:slug/config', async (c) => {
  const ws = await resolveWorkspace(c.req.param('slug'));
  return c.json({
    workspace: {
      slug:          ws.slug,
      name:          ws.name,
      primary_color: ws.primary_color || null,
      logo_url:      ws.logo_url || null,
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

  const { data, error } = await supabaseAdmin
    .from('kb_articles')
    .select('id, display_id, title, category, body, view_count, helpful_count, unhelpful_count, updated_at')
    .eq('workspace_id', ws.id)
    .eq('status', 'published')
    .order('updated_at', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);

  return c.json({ articles: data || [] });
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

function nextTicketDisplayId(): string {
  return `TK-${Math.floor(Math.random() * 900000 + 100000)}`;
}

function nextCustomerDisplayId(): string {
  return `M${String(Math.floor(Math.random() * 9000 + 1000))}`;
}

publicRoutes.post('/:slug/tickets', async (c) => {
  const ws = await resolveWorkspace(c.req.param('slug'));

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PublicTicket.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;
  const email = input.email.toLowerCase();

  // Match-or-create customer.
  let customerId: string;
  const { data: existing, error: lookupErr } = await supabaseAdmin
    .from('customers')
    .select('id')
    .eq('workspace_id', ws.id)
    .eq('email', email)
    .is('deleted_at', null)
    .maybeSingle();
  if (lookupErr) return c.json({ error: lookupErr.message }, 500);

  if (existing) {
    customerId = existing.id;
  } else {
    const [first, ...rest] = input.name.trim().split(/\s+/);
    const last = rest.join(' ') || null;
    const { data: created, error: createErr } = await supabaseAdmin
      .from('customers')
      .insert({
        workspace_id: ws.id,
        display_id:   nextCustomerDisplayId(),
        first_name:   first,
        last_name:    last,
        email,
      })
      .select('id')
      .single();
    if (createErr) {
      // Race recovery — same shape as the Postmark inbound handler.
      if (createErr.code === '23505') {
        const { data: winner } = await supabaseAdmin
          .from('customers')
          .select('id')
          .eq('workspace_id', ws.id)
          .eq('email', email)
          .maybeSingle();
        if (!winner) return c.json({ error: 'Customer race recovery failed' }, 500);
        customerId = winner.id;
      } else {
        return c.json({ error: createErr.message }, 500);
      }
    } else {
      customerId = created.id;
    }
  }

  // Create the ticket.
  const { data: ticket, error: tErr } = await supabaseAdmin
    .from('tickets')
    .insert({
      workspace_id: ws.id,
      display_id:   nextTicketDisplayId(),
      subject:      input.subject,
      customer_id:  customerId,
      status_key:   'open',
      priority_key: 'normal',
      sla_state:    'ok',
    })
    .select('id, display_id')
    .single();
  if (tErr) return c.json({ error: tErr.message }, 500);

  // First message — author_label uses the customer's submitted name.
  const { error: mErr } = await supabaseAdmin.from('ticket_messages').insert({
    workspace_id: ws.id,
    ticket_id:    ticket.id,
    role:         'customer',
    author_label: input.name,
    body:         input.body,
  });
  if (mErr) return c.json({ error: mErr.message, ticket }, 500);

  // Audit row so the agent UI can show "submitted via portal" if it
  // ever cares about the channel.
  await supabaseAdmin.from('audit_events').insert({
    workspace_id: ws.id,
    action:       'portal.ticket_submitted',
    target_type:  'ticket',
    target_id:    ticket.id,
    metadata:     { customer_id: customerId, from_email: email, from_name: input.name },
  });

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
  const ws = await resolveWorkspace(c.req.param('slug'));

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PostSuggest.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }

  try {
    const res = await suggestKbForQuestion({
      sb:          supabaseAdmin,
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
  const ws = await resolveWorkspace(c.req.param('slug'));

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PostAuthRequest.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const email = parsed.data.email.toLowerCase();

  const { data: customer } = await supabaseAdmin
    .from('customers')
    .select('id, first_name')
    .eq('workspace_id', ws.id)
    .eq('email', email)
    .is('deleted_at', null)
    .maybeSingle();

  const genericOk = { ok: true, message: 'If that email is on file, a sign-in link is on the way.' };
  if (!customer) return c.json(genericOk);

  let token: string;
  try {
    const link = await createMagicLink({ sb: supabaseAdmin, workspaceId: ws.id, customerId: customer.id });
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

  // Log so local dev / first-run setups can copy the link from console
  // even when Postmark isn't configured. Production: replace with a
  // structured log + remove the URL from the response.
  console.log(`[portal-auth] magic link for ${email}: ${url}`);

  // Best-effort email send. If POSTMARK_SERVER_TOKEN isn't set OR the
  // workspace has no verified domain, the call throws — we log + swallow
  // so the customer-facing response stays consistent.
  try {
    const from = await getOutboundFrom(supabaseAdmin, ws.id);
    if (from) {
      await sendEmail({
        to:        email,
        subject:   `Sign in to ${ws.name}`,
        textBody:  `Hi${customer.first_name ? ' ' + customer.first_name : ''},

You requested a sign-in link for ${ws.name}. Click below to view your tickets:

${url}

This link expires in 15 minutes. If you didn't request it, you can ignore this email.`,
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
  const ws = await resolveWorkspace(c.req.param('slug'));

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PostAuthVerify.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }

  const result = await verifyMagicLink({
    sb:          supabaseAdmin,
    workspaceId: ws.id,
    token:       parsed.data.token,
  });
  if (!result) return c.json({ error: 'Link is invalid or expired' }, 401);

  // Return the customer's basic info alongside the session so the portal
  // can greet them by name without a second round-trip.
  const { data: customer } = await supabaseAdmin
    .from('customers')
    .select('id, display_id, first_name, last_name, email')
    .eq('id', result.customerId)
    .maybeSingle();

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
  return customerForSession({ sb: supabaseAdmin, workspaceId, sessionToken });
}

// ─── GET /:slug/customer/tickets — list this customer's tickets ────────
publicRoutes.get('/:slug/customer/tickets', async (c) => {
  const ws = await resolveWorkspace(c.req.param('slug'));
  const sess = await withCustomer(c, ws.id);
  if (!sess) return c.json({ error: 'Sign in to view your tickets' }, 401);

  const { data, error } = await supabaseAdmin
    .from('tickets')
    .select('id, display_id, subject, status_key, priority_key, created_at, updated_at')
    .eq('workspace_id', ws.id)
    .eq('customer_id', sess.customerId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ tickets: data || [] });
});

// ─── GET /:slug/customer/tickets/:displayId — single ticket + messages ─
publicRoutes.get('/:slug/customer/tickets/:displayId', async (c) => {
  const ws = await resolveWorkspace(c.req.param('slug'));
  const sess = await withCustomer(c, ws.id);
  if (!sess) return c.json({ error: 'Sign in to view your tickets' }, 401);

  const displayId = c.req.param('displayId');
  const { data: ticket, error: tErr } = await supabaseAdmin
    .from('tickets')
    .select('id, display_id, subject, status_key, priority_key, created_at, updated_at')
    .eq('workspace_id', ws.id)
    .eq('display_id', displayId)
    .eq('customer_id', sess.customerId)  // scope: must be their ticket
    .is('deleted_at', null)
    .maybeSingle();
  if (tErr) return c.json({ error: tErr.message }, 500);
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

  // Strip internal notes — those are agent-private.
  const { data: messages, error: mErr } = await supabaseAdmin
    .from('ticket_messages')
    .select('id, role, author_label, body, created_at')
    .eq('ticket_id', ticket.id)
    .in('role', ['customer', 'agent', 'ai'])
    .is('deleted_at', null)
    .order('created_at', { ascending: true });
  if (mErr) return c.json({ error: mErr.message }, 500);

  return c.json({ ticket: { ...ticket, messages: messages || [] } });
});

// ─── POST /:slug/customer/tickets/:displayId/messages — customer reply ─
const PostCustomerReply = z.object({
  body: z.string().min(1).max(20000),
});

publicRoutes.post('/:slug/customer/tickets/:displayId/messages', async (c) => {
  const ws = await resolveWorkspace(c.req.param('slug'));
  const sess = await withCustomer(c, ws.id);
  if (!sess) return c.json({ error: 'Sign in to reply' }, 401);

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PostCustomerReply.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }

  const displayId = c.req.param('displayId');
  const { data: ticket, error: tErr } = await supabaseAdmin
    .from('tickets')
    .select('id, status_key')
    .eq('workspace_id', ws.id)
    .eq('display_id', displayId)
    .eq('customer_id', sess.customerId)
    .is('deleted_at', null)
    .maybeSingle();
  if (tErr) return c.json({ error: tErr.message }, 500);
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

  // Fetch the customer's name for the author_label so the thread renders
  // identically to messages that came in via Postmark inbound.
  const { data: customer } = await supabaseAdmin
    .from('customers')
    .select('first_name, last_name, email')
    .eq('id', sess.customerId)
    .maybeSingle();
  const authorLabel = customer
    ? `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || customer.email || 'Customer'
    : 'Customer';

  const { data: message, error: mErr } = await supabaseAdmin
    .from('ticket_messages')
    .insert({
      workspace_id: ws.id,
      ticket_id:    ticket.id,
      role:         'customer',
      author_label: authorLabel,
      body:         parsed.data.body,
    })
    .select('id, role, author_label, body, created_at')
    .single();
  if (mErr) return c.json({ error: mErr.message }, 500);

  // Customer reply un-resolves the ticket so agents see it back in the
  // open queue. Mirrors the normal inbound-email behaviour.
  if (ticket.status_key === 'resolved') {
    await supabaseAdmin.from('tickets')
      .update({ status_key: 'open' })
      .eq('id', ticket.id)
      .eq('workspace_id', ws.id);
  }

  return c.json({ message }, 201);
});

// ─── CSAT survey: token-gated, no portal session needed ──────────────────
//
// The customer reaches this through a link in the auto-survey email; we
// don't ask them to sign in (the link is itself the proof). GET returns
// the minimal ticket context; POST records the rating + optional
// comment. Either endpoint returns 404 for unknown tokens — that's both
// "wrong token" and "already submitted with a token we'd have rotated",
// because token revocation isn't built yet.

publicRoutes.get('/:slug/csat/:token', async (c) => {
  const ws = await resolveWorkspace(c.req.param('slug'));
  const token = c.req.param('token');
  const { data: ticket, error } = await supabaseAdmin
    .from('tickets')
    .select('id, display_id, subject, csat_score, csat_submitted_at, customers(first_name)')
    .eq('workspace_id', ws.id)
    .eq('csat_token', token)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new HTTPException(500, { message: error.message });
  if (!ticket) throw new HTTPException(404, { message: 'Survey not found' });
  const t = ticket as any;
  return c.json({
    workspace: { name: ws.name, slug: ws.slug, primary_color: ws.primary_color, logo_url: ws.logo_url },
    ticket: {
      display_id:    t.display_id,
      subject:       t.subject,
      customer_name: t.customers?.first_name || null,
      submitted_at:  t.csat_submitted_at,
      score:         t.csat_score,
    },
  });
});

const CsatSubmit = z.object({
  score:   z.number().int().min(1).max(5),
  comment: z.string().max(2000).nullable().optional(),
});

publicRoutes.post('/:slug/csat/:token', async (c) => {
  const ws = await resolveWorkspace(c.req.param('slug'));
  const token = c.req.param('token');
  const reqBody = await c.req.json().catch(() => null);
  const parsed = CsatSubmit.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }

  // Refuse to overwrite a submitted rating — the survey is one-shot,
  // matches what the SPA's manual rating flow does.
  const { data: ticket, error: lookupErr } = await supabaseAdmin
    .from('tickets')
    .select('id, csat_submitted_at')
    .eq('workspace_id', ws.id)
    .eq('csat_token', token)
    .is('deleted_at', null)
    .maybeSingle();
  if (lookupErr) throw new HTTPException(500, { message: lookupErr.message });
  if (!ticket) throw new HTTPException(404, { message: 'Survey not found' });
  if (ticket.csat_submitted_at) {
    return c.json({ error: 'Survey already submitted' }, 409);
  }

  const { error: upErr } = await supabaseAdmin
    .from('tickets')
    .update({
      csat_score:        parsed.data.score,
      csat_stars:        parsed.data.score, // legacy mirror — both columns exist
      csat_comment:      parsed.data.comment || null,
      csat_submitted_at: new Date().toISOString(),
    })
    .eq('id', ticket.id)
    .eq('workspace_id', ws.id);
  if (upErr) throw new HTTPException(500, { message: upErr.message });

  return c.json({ ok: true });
});
