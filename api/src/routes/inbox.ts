import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';

export const inbox = new Hono();

inbox.use('*', requireAuth);

// Placeholder display-id generator — same shape as routes/tickets.ts.
// Replace with a per-workspace sequence (or trigger) before real-user
// scale.
function nextTicketDisplayId(): string {
  return `TK-${Math.floor(Math.random() * 900000 + 100000)}`;
}

// List inbox_messages in the active workspace. Joined with tickets for
// converted_ticket display_id (so the UI can deep-link "Open TK-XXX"
// without an extra fetch).
//
// Returns the raw DB shape; the SPA remaps fields to data.js's INBOX
// view-model on the client.
inbox.get('/', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');

  // Two FKs link inbox_messages ↔ tickets (converted_ticket_id and the
  // reverse source_inbox_id), so PostgREST needs the constraint name to
  // disambiguate. Embed via the converted_ticket_id FK only.
  const { data, error } = await sb
    .from('inbox_messages')
    .select(`
      id, channel_id, from_name, from_email, subject, body, received_at, status,
      converted_ticket_id,
      tickets!inbox_messages_converted_ticket_fk(display_id)
    `)
    .eq('workspace_id', workspaceId)
    .order('received_at', { ascending: false });

  if (error) return c.json({ error: error.message }, 500);

  const inbox = (data || []).map((row: any) => ({
    id:                   row.id,
    channel_id:           row.channel_id,
    from_name:            row.from_name,
    from_email:           row.from_email,
    subject:              row.subject,
    body:                 row.body,
    received_at:          row.received_at,
    status:               row.status,
    converted_ticket_display_id: row.tickets?.display_id || null,
  }));

  return c.json({ inbox });
});

// ─── PATCH /:id — change status (dismiss / spam / restore) ────────────────
//
// Refuses to touch already-converted rows: the conversion is an audit
// trail, not a state to be flipped back. Restore is just "set to new" with
// the converted guard.

const PatchInbox = z.object({
  status: z.enum(['new', 'dismissed', 'spam']),
});

inbox.patch('/:id', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = PatchInbox.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }

  const { data: existing, error: lookupErr } = await sb
    .from('inbox_messages')
    .select('id, status, converted_ticket_id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (lookupErr) return c.json({ error: lookupErr.message }, 500);
  if (!existing)  return c.json({ error: 'Inbox message not found' }, 404);
  if (existing.status === 'converted') {
    return c.json({ error: 'Cannot change status of a converted message' }, 409);
  }

  const { data: updated, error: updErr } = await sb
    .from('inbox_messages')
    .update({ status: parsed.data.status })
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select('id, status')
    .single();
  if (updErr) return c.json({ error: updErr.message }, 500);

  return c.json({ inbox_message: updated });
});

// ─── POST /:id/convert — create a ticket from this email ──────────────────
//
// Mirrors the client's old convertEmailToTicket logic, server-side.
// Refuses if no customer matches the from_email (matches the SPA's UX —
// agent has to add the customer first or use the new-ticket form). Marks
// the inbox row converted on success.

inbox.post('/:id/convert', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const { data: msg, error: lookupErr } = await sb
    .from('inbox_messages')
    .select('id, status, channel_id, from_name, from_email, subject, body')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (lookupErr) return c.json({ error: lookupErr.message }, 500);
  if (!msg)       return c.json({ error: 'Inbox message not found' }, 404);
  if (msg.status === 'converted') {
    return c.json({ error: 'Already converted' }, 409);
  }

  // Match the sender against customers by email — required, no silent
  // CUSTOMERS[0] fallback. Front-end already blocks the button when no
  // match is shown, so this is defense-in-depth for direct callers.
  const { data: customer, error: cErr } = await sb
    .from('customers')
    .select('id, first_name, last_name')
    .eq('workspace_id', workspaceId)
    .eq('email', msg.from_email)
    .is('deleted_at', null)
    .maybeSingle();
  if (cErr) return c.json({ error: cErr.message }, 500);
  if (!customer) {
    return c.json({
      error: 'No customer matches the sender email; add the customer first.',
      from_email: msg.from_email,
    }, 409);
  }

  // Pick category from the channel default, if any.
  let categoryKey: string | null = null;
  if (msg.channel_id) {
    const { data: ch } = await sb
      .from('channels')
      .select('default_category_key')
      .eq('id', msg.channel_id)
      .maybeSingle();
    categoryKey = ch?.default_category_key || null;
  }

  const { data: ticket, error: tErr } = await sb
    .from('tickets')
    .insert({
      workspace_id:    workspaceId,
      display_id:      nextTicketDisplayId(),
      subject:         msg.subject || '(no subject)',
      customer_id:     customer.id,
      status_key:      'open',
      priority_key:    'normal',
      category_key:    categoryKey,
      source_inbox_id: msg.id,
      sla_state:       'ok',
    })
    .select('id, display_id')
    .single();
  if (tErr) return c.json({ error: tErr.message }, 500);

  const { error: mErr } = await sb.from('ticket_messages').insert({
    workspace_id: workspaceId,
    ticket_id:    ticket.id,
    role:         'customer',
    author_label: `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || msg.from_email || 'Customer',
    body:         msg.body || '',
  });
  if (mErr) return c.json({ error: mErr.message, ticket }, 500);

  const { error: upErr } = await sb
    .from('inbox_messages')
    .update({ status: 'converted', converted_ticket_id: ticket.id })
    .eq('id', id)
    .eq('workspace_id', workspaceId);
  if (upErr) return c.json({ error: upErr.message, ticket }, 500);

  return c.json({ ticket }, 201);
});
