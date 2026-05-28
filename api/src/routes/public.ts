import { Hono } from 'hono';
import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import { supabaseAdmin } from '../lib/supabase.ts';

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
