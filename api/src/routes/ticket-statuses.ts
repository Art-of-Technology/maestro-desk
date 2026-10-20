import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspaceAdmin } from '../lib/authz.js';
import { getDb } from '../lib/db.js';
import { statusCategories } from '../lib/ticket-status.js';

export const ticketStatuses = new Hono();
ticketStatuses.use('*', requireAuth);
const Fields = z.object({ label: z.string().trim().min(1).max(80), send_survey: z.boolean(), is_active: z.boolean() }).strict();
const Create = Fields.omit({ is_active: true }).extend({ base_key: z.enum(statusCategories) }).strict();
const keyPattern = /^[a-z][a-z0-9-]{0,63}$/;

ticketStatuses.get('/', async c => {
  const rows = await getDb()`select key, label, base_key, send_survey, is_active, sort_order from ticket_statuses
    where workspace_id = ${c.get('workspaceId')} order by sort_order, label, key`;
  return c.json({ statuses: rows });
});

ticketStatuses.post('/', async c => {
  const denied = await requireWorkspaceAdmin(c); if (denied) return denied;
  const parsed = Create.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || (parsed.data.send_survey && parsed.data.base_key !== 'resolved')) return c.json({ error: 'Choose a name, category and valid survey behaviour.' }, 400);
  const d = parsed.data, key = `custom-${crypto.randomUUID()}`, ws = c.get('workspaceId');
  const row = await getDb().begin(async sql => {
    const [saved] = await sql`insert into ticket_statuses(workspace_id, key, label, base_key, send_survey, sort_order)
      values(${ws}, ${key}, ${d.label}, ${d.base_key}, ${d.send_survey}, 50) returning *`;
    await sql`insert into audit_events(workspace_id, actor_user_id, action, target_type, metadata)
      values(${ws}, ${c.get('userId')}, 'ticket_status.created', 'ticket_status', ${sql.json({ key, ...d })})`;
    return saved;
  });
  return c.json({ status: row }, 201);
});

ticketStatuses.put('/:key', async c => {
  const denied = await requireWorkspaceAdmin(c); if (denied) return denied;
  const key = c.req.param('key'), ws = c.get('workspaceId');
  if (!keyPattern.test(key)) return c.json({ error: 'Status not found.' }, 404);
  const parsed = Fields.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Choose a name and valid survey behaviour.' }, 400);
  const result = await getDb().begin(async sql => {
    const [old] = await sql`select * from ticket_statuses where workspace_id = ${ws} and key = ${key} for update`;
    if (!old) return c.json({ error: 'Status not found.' }, 404);
    const d = parsed.data;
    if ((d.send_survey && old.base_key !== 'resolved') || (!d.is_active && statusCategories.includes(key as typeof statusCategories[number]))) {
      return c.json({ error: 'Keep built-in statuses available. Only resolved statuses can send surveys.' }, 400);
    }
    if (!d.is_active) {
      const [macro] = await sql`select id from workspace_macros where workspace_id=${ws} and deleted_at is null
        and actions @> ${sql.json([{ kind: 'status', value: key }])}::jsonb limit 1`;
      if (macro) return c.json({ error: 'Update macros using this status before retiring it.' }, 409);
    }
    const [saved] = await sql`update ticket_statuses set label=${d.label}, send_survey=${d.send_survey}, is_active=${d.is_active}
      where workspace_id=${ws} and key=${key} returning *`;
    await sql`insert into audit_events(workspace_id, actor_user_id, action, target_type, metadata)
      values(${ws}, ${c.get('userId')}, 'ticket_status.updated', 'ticket_status',
        ${sql.json({ key, label_changed: old.label !== d.label, before: { send_survey: old.send_survey, is_active: old.is_active }, after: { send_survey: d.send_survey, is_active: d.is_active } })})`;
    return c.json({ status: saved });
  });
  return result;
});
