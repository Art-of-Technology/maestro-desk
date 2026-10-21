import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../lib/db.js';

const Input = z.object({ version: z.number().int().min(0).max(2147483646), generation: z.number().int().min(0).max(2147483646), pending: z.boolean() }).strict();
// Identity and workspace membership come from the parent ticket router.
export const closeReminders = new Hono();
closeReminders.use('/:id/close-reminder', async (c, next) => {
  if (!z.string().uuid().safeParse(c.req.param('id')).success) return c.json({ error: 'Ticket not found' }, 404);
  const [ticket] = await getDb()`select t.id from tickets t
    join customers c on c.id=t.customer_id and c.workspace_id=t.workspace_id
    where t.id=${c.req.param('id')} and t.workspace_id=${c.get('workspaceId')}
      and t.deleted_at is null and c.erased_at is null and c.deleted_at is null`;
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
  c.header('Cache-Control', 'no-store');
  await next();
});
closeReminders.get('/:id/close-reminder', async c => {
  const [reminder] = await getDb()`select coalesce(r.pending,false) as pending,coalesce(r.version,0) as version,t.close_reminder_generation as generation
    from tickets t left join ticket_close_reminders r on r.ticket_id=t.id and r.workspace_id=t.workspace_id and r.user_id=${c.get('userId')}
    where t.workspace_id=${c.get('workspaceId')} and t.id=${c.req.param('id')} and t.deleted_at is null`;
  if (!reminder) return c.json({ error: 'Ticket not found' }, 404);
  return c.json({ reminder });
});
closeReminders.put('/:id/close-reminder', async c => {
  const parsed = Input.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid close reminder' }, 400);
  const workspace = c.get('workspaceId'), user = c.get('userId'), ticketId = c.req.param('id');
  const result = await getDb().begin(async sql => {
    // Match draft saves and erasure: customer before ticket.
    const [customer] = await sql`select c.erased_at,c.deleted_at from customers c join tickets t
      on t.customer_id=c.id and t.workspace_id=c.workspace_id
      where t.id=${ticketId} and t.workspace_id=${workspace} for share of c`;
    if (!customer || customer.erased_at || customer.deleted_at) return null;
    const [ticket] = await sql`select id,status_key,merged_into_id,close_reminder_generation from tickets
      where id=${ticketId} and workspace_id=${workspace} and deleted_at is null for update`;
    if (!ticket) return null;
    await sql`insert into ticket_close_reminders(workspace_id,ticket_id,user_id)
      values (${workspace},${ticketId},${user}) on conflict do nothing`;
    const [existing] = await sql`select pending,version from ticket_close_reminders
      where workspace_id=${workspace} and ticket_id=${ticketId} and user_id=${user}`;
    if (existing.version !== parsed.data.version || ticket.close_reminder_generation !== parsed.data.generation)
      return { conflict: true, reminder: { ...existing, generation: ticket.close_reminder_generation } };
    const pending = parsed.data.pending && ticket.status_key !== 'closed' && !ticket.merged_into_id;
    const [saved] = await sql`update ticket_close_reminders set pending=${pending},version=version+1
      where workspace_id=${workspace} and ticket_id=${ticketId} and user_id=${user}
      returning pending,version`;
    return { conflict: false, reminder: { ...saved, generation: ticket.close_reminder_generation } };
  });
  if (!result) return c.json({ error: 'Ticket not found' }, 404);
  if (result.conflict) return c.json({ error: 'Reminder changed on another device.', reminder: result.reminder }, 409);
  return c.json({ reminder: result.reminder });
});
