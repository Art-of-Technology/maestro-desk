import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../lib/db.js';
import { dashboardReport, parseReportPeriod } from '../lib/dashboard-report.js';
import { requireWorkspaceAdmin } from '../lib/authz.js';
import { ReplyPerformanceQuery, replyPerformance } from '../lib/reply-performance.js';
import { LanguageDetectionRange, languageDetectionReport } from '../lib/language-detection-report.js';

// Server-side report data. SLA breach evaluation itself stays client-side
// (business-hours engine in web/js/tickets/sla.js); this endpoint only
// supplies the timing facts the SPA can't derive from its paginated ticket
// snapshot — most importantly first_agent_reply_at, which needs a scan over
// ticket_messages. Reads are member-level, like sla-policies.
export const reports = new Hono();

reports.use('*', requireAuth);

reports.get('/reply-performance', async c => {
  c.header('Cache-Control','no-store');
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;
  const parsed = ReplyPerformanceQuery.safeParse(c.req.query());
  if (!parsed.success) return c.json({error:'Choose valid filters and a date range of up to 366 days.'},400);
  const report = await replyPerformance(c.get('workspaceId'),parsed.data);
  if (!report) return c.json({error:'More than 10,000 suggestions match. Narrow the date range or filters before exporting.'},422);
  return c.json(report);
});

reports.get('/dashboard', async (c) => {
  const period = parseReportPeriod(c.req.query('start'), c.req.query('end'), c.req.query('timezone'));
  if (!period) return c.json({ error: 'Provide valid start/end timestamps and timezone.' }, 400);
  return c.json({ period, report: await dashboardReport(c.get('workspaceId'), c.get('userId'), period) });
});

reports.get('/language-detection', async c => {
  c.header('Cache-Control', 'no-store');
  const range = LanguageDetectionRange.safeParse(c.req.query('range') ?? '30d');
  if (!range.success) return c.json({ error: 'range must be 7d, 30d, 90d or all' }, 400);
  return c.json(await languageDetectionReport(c.get('workspaceId'), range.data));
});

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
      and t.status_key <> 'closed'
      and t.created_at >= now() - (${days} * interval '1 day')
    order by t.created_at desc
    limit ${MAX_ROWS + 1}
  `;
  const truncated = rows.length > MAX_ROWS;
  return c.json({ days, truncated, tickets: truncated ? rows.slice(0, MAX_ROWS) : rows });
});
