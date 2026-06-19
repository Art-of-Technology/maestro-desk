import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../lib/db.js';
import { nextDisplayId } from '../lib/display-id.js';

// Migration to Neon — Step 3. Member-level, workspace-scoped via getDb().
export const inbox = new Hono();

inbox.use('*', requireAuth);

// List inbox_messages, joined to tickets for the converted ticket's display_id
// (so the UI can deep-link without an extra fetch).
inbox.get('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const rows = await sql`
    select i.id, i.channel_id, i.from_name, i.from_email, i.subject, i.body, i.received_at, i.status,
           i.converted_ticket_id, t.display_id as converted_ticket_display_id
    from inbox_messages i
    left join tickets t on t.id = i.converted_ticket_id
    where i.workspace_id = ${workspaceId}
    order by i.received_at desc
  `;
  const inbox = rows.map((row) => ({
    id:                          row.id,
    channel_id:                  row.channel_id,
    from_name:                   row.from_name,
    from_email:                  row.from_email,
    subject:                     row.subject,
    body:                        row.body,
    received_at:                 row.received_at,
    status:                      row.status,
    converted_ticket_display_id: row.converted_ticket_display_id ?? null,
  }));
  return c.json({ inbox });
});

// ─── PATCH /:id — change status (dismiss / spam / restore) ────────────────
// Refuses to touch already-converted rows (the conversion is an audit trail).
const PatchInbox = z.object({
  status: z.enum(['new', 'dismissed', 'spam']),
});

inbox.patch('/:id', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = PatchInbox.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }

  const [existing] = await sql`
    select id, status, converted_ticket_id from inbox_messages
    where id = ${id} and workspace_id = ${workspaceId}
  `;
  if (!existing) return c.json({ error: 'Inbox message not found' }, 404);
  if (existing.status === 'converted') {
    return c.json({ error: 'Cannot change status of a converted message' }, 409);
  }

  const [updated] = await sql`
    update inbox_messages set status = ${parsed.data.status}
    where id = ${id} and workspace_id = ${workspaceId}
    returning id, status
  `;
  return c.json({ inbox_message: updated });
});

// ─── POST /:id/convert — create a ticket from this email ──────────────────
// Refuses if no customer matches the from_email. Marks the inbox row
// converted on success. The ticket + first message + status flip run in a
// single transaction so a partial failure can't orphan a ticket.
inbox.post('/:id/convert', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const [msg] = await sql`
    select id, status, channel_id, from_name, from_email, subject, body
    from inbox_messages
    where id = ${id} and workspace_id = ${workspaceId}
  `;
  if (!msg) return c.json({ error: 'Inbox message not found' }, 404);
  if (msg.status === 'converted') {
    return c.json({ error: 'Already converted' }, 409);
  }

  // Match the sender against customers by email — required (defense-in-depth;
  // the front-end blocks the button when there's no match).
  const [customer] = await sql`
    select id, first_name, last_name from customers
    where workspace_id = ${workspaceId} and email = ${msg.from_email} and deleted_at is null
  `;
  if (!customer) {
    return c.json({
      error: 'No customer matches the sender email; add the customer first.',
      from_email: msg.from_email,
    }, 409);
  }

  // Category from the channel default, if any.
  let categoryKey: string | null = null;
  if (msg.channel_id) {
    const [ch] = await sql`select default_category_key from channels where id = ${msg.channel_id}`;
    categoryKey = ch?.default_category_key || null;
  }

  const authorLabel =
    `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || msg.from_email || 'Customer';

  const ticket = await sql.begin(async (tx) => {
    const displayId = await nextDisplayId(tx, workspaceId, 'ticket');
    const [t] = await tx`
      insert into tickets
        (workspace_id, display_id, subject, customer_id, status_key, priority_key, category_key, source_inbox_id, sla_state)
      values
        (${workspaceId}, ${displayId}, ${msg.subject || '(no subject)'}, ${customer.id},
         'open', 'normal', ${categoryKey}, ${msg.id}, 'ok')
      returning id, display_id
    `;
    await tx`
      insert into ticket_messages (workspace_id, ticket_id, role, author_label, body)
      values (${workspaceId}, ${t.id}, 'customer', ${authorLabel}, ${msg.body || ''})
    `;
    await tx`
      update inbox_messages set status = 'converted', converted_ticket_id = ${t.id}
      where id = ${id} and workspace_id = ${workspaceId}
    `;
    return t;
  });

  return c.json({ ticket }, 201);
});
