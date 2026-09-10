import { getDb } from './db.js';

export function parseReportPeriod(start?: string, end?: string, timezone = 'UTC') {
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
  if (!start || !end || !iso.test(start) || !iso.test(end)) return null;
  const from = new Date(start), to = new Date(end);
  if (!Number.isFinite(+from) || !Number.isFinite(+to) || +to <= +from) return null;
  if (from.toISOString().slice(0, 19) !== start.slice(0, 19) || to.toISOString().slice(0, 19) !== end.slice(0, 19)) return null;
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(from); } catch { return null; }
  return { start: from.toISOString(), end: to.toISOString(), timezone };
}

// All aggregates share one statement/snapshot. No ticket-page limit applies.
export async function dashboardReport(workspaceId: string, userId: string, period: NonNullable<ReturnType<typeof parseReportPeriod>>) {
  const sql = getDb();
  const { start, end, timezone } = period;
  const [row] = await sql`
    with scoped as materialized (
      select * from tickets where workspace_id = ${workspaceId}
        and deleted_at is null and merged_into_id is null
    ), cohort as materialized (
      select * from scoped where created_at >= ${start}::timestamptz and created_at < ${end}::timestamptz
    ), rated as (
      select csat_score from scoped where csat_submitted_at >= ${start}::timestamptz
        and csat_submitted_at < ${end}::timestamptz and csat_score is not null
    )
    select jsonb_build_object(
      'created', (select count(*) from cohort),
      'resolved', (select count(*) from scoped where status_key = 'resolved'
        and resolved_at >= ${start}::timestamptz and resolved_at < ${end}::timestamptz),
      'closed', (select count(*) from scoped where status_key = 'closed'
        and closed_at >= ${start}::timestamptz and closed_at < ${end}::timestamptz),
      'replies', (select count(*) from ticket_messages m join scoped t on t.id = m.ticket_id
        where m.workspace_id = ${workspaceId} and m.deleted_at is null and m.merged_from_id is null
        and m.role in ('agent', 'ai') and m.created_at >= ${start}::timestamptz and m.created_at < ${end}::timestamptz),
      'csatCount', (select count(*) from rated), 'avgCSAT', (select avg(csat_score) from rated),
      'byStatus', coalesce((select jsonb_object_agg(status_key, n) from
        (select status_key, count(*) n from cohort group by status_key) s), '{}'::jsonb),
      'byPriority', coalesce((select jsonb_object_agg(priority_key, n) from
        (select priority_key, count(*) n from cohort group by priority_key) s), '{}'::jsonb),
      'bySla', coalesce((select jsonb_object_agg(sla_state, n) from
        (select coalesce(sla_state, 'unknown') sla_state, count(*) n from cohort where status_key not in ('resolved', 'closed') group by sla_state) s), '{}'::jsonb),
      'volume', coalesce((select jsonb_agg(s order by "day") from
        (select to_char(created_at at time zone ${timezone}, 'YYYY-MM-DD') as "day", count(*) n
          from cohort group by "day") s), '[]'::jsonb),
      'recent', coalesce((select jsonb_agg(s order by created_at desc, id) from
        (select id, display_id, subject, status_key, created_at from cohort order by created_at desc, id limit 6) s), '[]'::jsonb),
      'agents', coalesce((select jsonb_agg(s order by n desc, name) from
        (select coalesce(u.name, 'Unassigned') name, count(*) n from cohort t
          left join users u on u.id = t.assigned_user_id
          where t.status_key not in ('resolved', 'closed') group by u.id, u.name) s), '[]'::jsonb),
      'customers', coalesce((select jsonb_agg(s order by n desc, name) from
        (select c.display_id id, concat_ws(' ', c.first_name, c.last_name) name, count(*) n
          from cohort t join customers c on c.id = t.customer_id and c.workspace_id = ${workspaceId}
          group by c.id order by n desc, c.id limit 5) s), '[]'::jsonb),
      'mine', (select count(*) from cohort where assigned_user_id = ${userId} and status_key not in ('resolved', 'closed')),
      'aiTags', (select count(*) from ticket_ai_tags a join cohort t on t.id = a.ticket_id
        where a.workspace_id = ${workspaceId} and not a.accepted)
    ) as report`;
  return row.report;
}
