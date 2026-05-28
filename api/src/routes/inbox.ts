import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.ts';

export const inbox = new Hono();

inbox.use('*', requireAuth);

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
