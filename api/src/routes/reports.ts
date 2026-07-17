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

// Hard cap on the result set so a pathological workspace can't stream an
// unbounded JSON body. Newest tickets win (the query orders created_at
// desc); the response flags truncation so the client can say the numbers
// are partial rather than silently under-reporting.
const MAX_ROWS = 5000;

reports.get('/sla-breaches', async (c) => {
  const days = Number(c.req.query('days') ?? 30);
  if (!ALLOWED_DAYS.has(days)) {
    return c.json({ error: 'days must be 7, 30 or 90' }, 400);
  }
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  // Message rows with merged_from_id are copies stamped at merge time, not
  // real replies — excluding them keeps a merge from fabricating a first
  // response. The reply must also FOLLOW the first customer message: an
  // agent-initiated (outbound) thread has no first-response obligation, so
  // fc is null and fr stays null with it; the client skips the first-reply
  // target for those. Merged tickets themselves are excluded: their thread
  // lives on in the merge target, so counting both would double-report.
  const rows = await sql`
    select t.id, t.display_id, t.subject,
           t.status_key, t.priority_key, t.category_key,
           u.name as assignee_name,
           t.created_at, t.resolved_at, t.snoozed_until,
           fc.first_customer_at, fr.first_agent_reply_at
    from tickets t
    left join users u on u.id = t.assigned_user_id
    left join lateral (
      select min(tm.created_at) as first_customer_at
      from ticket_messages tm
      where tm.ticket_id = t.id
        and tm.role = 'customer'
        and tm.deleted_at is null
        and tm.merged_from_id is null
    ) fc on true
    left join lateral (
      select min(tm.created_at) as first_agent_reply_at
      from ticket_messages tm
      where tm.ticket_id = t.id
        and tm.role in ('agent', 'ai')
        and tm.deleted_at is null
        and tm.merged_from_id is null
        and tm.created_at >= fc.first_customer_at
    ) fr on true
    where t.workspace_id = ${workspaceId}
      and t.deleted_at is null
      and t.merged_into_id is null
      and t.created_at >= now() - (${days} * interval '1 day')
    order by t.created_at desc
    limit ${MAX_ROWS + 1}
  `;
  const truncated = rows.length > MAX_ROWS;
  return c.json({ days, truncated, tickets: truncated ? rows.slice(0, MAX_ROWS) : rows });
});
