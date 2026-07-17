import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../lib/db.js';

// Server-side report data. SLA breach evaluation itself stays client-side
// (business-hours engine in web/js/tickets/sla.js); this endpoint only
// supplies the timing facts the SPA can't derive from its paginated ticket
// snapshot — most importantly first_agent_reply_at, which needs a scan over
// ticket_messages. Reads are member-level, like sla-policies.
export const reports = new Hono();

reports.use('*', requireAuth);

const ALLOWED_DAYS = new Set([7, 30, 90]);

reports.get('/sla-breaches', async (c) => {
  const days = Number(c.req.query('days') ?? 30);
  if (!ALLOWED_DAYS.has(days)) {
    return c.json({ error: 'days must be 7, 30 or 90' }, 400);
  }
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  // Merged tickets are excluded: their thread lives on in the merge target,
  // so counting both would double-report the same conversation.
  const rows = await sql`
    select t.id, t.display_id, t.subject,
           t.status_key, t.priority_key, t.category_key,
           t.assigned_user_id, u.name as assignee_name,
           t.created_at, t.resolved_at, t.snoozed_until,
           fr.first_agent_reply_at
    from tickets t
    left join users u on u.id = t.assigned_user_id
    left join lateral (
      select min(tm.created_at) as first_agent_reply_at
      from ticket_messages tm
      where tm.ticket_id = t.id
        and tm.role in ('agent', 'ai')
        and tm.deleted_at is null
    ) fr on true
    where t.workspace_id = ${workspaceId}
      and t.deleted_at is null
      and t.merged_into_id is null
      and t.created_at >= now() - (${days} * interval '1 day')
    order by t.created_at desc
  `;
  return c.json({ days, tickets: rows });
});
