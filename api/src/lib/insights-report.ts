import { z } from 'zod';
import { getDb } from './db.js';
import { parseReportPeriod } from './dashboard-report.js';

export const InsightsQuery = z.object({
  range: z.enum(['7d', '30d', '90d', 'all']).default('30d'),
  end: z.string().refine(value => !!parseReportPeriod('1970-01-01T00:00:00Z', value)).optional(),
  export: z.enum(['0', '1']).default('0'),
});

export async function insightsReport(workspaceId: string, query: z.infer<typeof InsightsQuery>, now = new Date()) {
  const sql = getDb();
  const end = query.end ? new Date(query.end) : now;
  const start = query.range === 'all' ? null : new Date(end);
  if (start) {
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - parseInt(query.range) + 1);
  }
  const period = { range: query.range, start: start?.toISOString() || null, end: end.toISOString(), timezone: 'UTC' };
  const cohort = sql`select * from tickets where workspace_id = ${workspaceId}
    and deleted_at is null and merged_into_id is null
    and (${start}::timestamptz is null or created_at >= ${start}) and created_at < ${end}`;

  if (query.export === '1') {
    // ponytail: cap synchronous exports at 10,000 rows; use background exports if larger files are needed.
    const rows = await sql`
      with cohort as (${cohort}), limited as (
        select * from cohort order by created_at, id limit 10001
      )
      select t.display_id id, t.subject, t.status_key status, t.priority_key priority,
        coalesce(t.category_key, 'Other') category, coalesce(u.name, 'Unassigned') agent,
        t.created_at created, t.updated_at updated, t.sla_state sla, t.csat_score csat,
        t.latest_customer_sentiment sentiment,
        coalesce(tm.total, 0)::int as "timeTotal", coalesce(tm.billable, 0)::int as "timeBillable"
      from limited t left join users u on u.id = t.assigned_user_id
      left join lateral (
        select sum(minutes) total, sum(minutes) filter (where billable) billable
        from time_entries where workspace_id = ${workspaceId} and ticket_id = t.id
      ) tm on true order by t.created_at, t.id
    `;
    return rows.length > 10000 ? null : { period, tickets: rows };
  }

  // One database snapshot; every breakdown uses the same complete creation cohort.
  const [result] = await sql`
    with cohort as materialized (${cohort}), times as materialized (
      select e.* from time_entries e join cohort t on t.id = e.ticket_id where e.workspace_id = ${workspaceId}
    ), bounds as (
      select coalesce(${start}::timestamptz, min(created_at), ${end}::timestamptz) at time zone 'UTC' as first from cohort
    ), bucket_size as (
      select first::date, greatest(1, ceil(((${end}::timestamptz at time zone 'UTC')::date - first::date + 1)::numeric / 30))::int days from bounds
    ), buckets as (
      select first + n * days as day, days from bucket_size,
        generate_series(0, ((${end}::timestamptz at time zone 'UTC')::date - first) / days) n
    )
    select jsonb_build_object(
      'total', (select count(*) from cohort),
      'byStatus', (select coalesce(jsonb_object_agg(k,n),'{}') from (select status_key k,count(*) n from cohort group by 1) x),
      'byPriority', (select coalesce(jsonb_object_agg(k,n),'{}') from (select priority_key k,count(*) n from cohort group by 1) x),
      'byCategory', (select coalesce(jsonb_object_agg(k,n),'{}') from (select coalesce(category_key,'Other') k,count(*) n from cohort group by 1) x),
      'agents', (select coalesce(jsonb_agg(x order by x.n desc,x.id),'[]') from (
        select t.assigned_user_id id, coalesce(u.name,'Unassigned') name, count(*) n from cohort t
        left join users u on u.id = t.assigned_user_id group by t.assigned_user_id,u.name) x),
      'bySentiment', (select coalesce(jsonb_object_agg(k,n),'{}') from (select latest_customer_sentiment k,count(*) n from cohort where latest_customer_sentiment is not null group by 1) x),
      'sentimentScored', (select count(latest_customer_sentiment) from cohort),
      'csatBuckets', (select jsonb_agg(n order by score) from (select score,(select count(*) from cohort where csat_score = score) n from generate_series(1,5) score) x),
      'csatCount', (select count(csat_score) from cohort),
      'avgCSAT', (select coalesce(avg(csat_score),0) from cohort),
      'slaOk', (select count(*) from cohort where status_key <> 'closed' and sla_state = 'ok'),
      'slaWarn', (select count(*) from cohort where status_key <> 'closed' and sla_state = 'warn'),
      'slaBreach', (select count(*) from cohort where status_key <> 'closed' and sla_state = 'breach'),
      'timeTotal', (select coalesce(sum(minutes),0) from times),
      'timeBillable', (select coalesce(sum(minutes) filter (where billable),0) from times),
      'timeAgents', (select coalesce(jsonb_agg(x order by x.total desc,x.id),'[]') from (
        select e.user_id id,coalesce(u.name,'Unknown agent') name,sum(minutes) total,
          coalesce(sum(minutes) filter (where billable),0) billable
        from times e left join users u on u.id = e.user_id group by e.user_id,u.name) x),
      'sentimentTrend', (select coalesce(jsonb_agg(x order by x.start),'[]') from (
        select b.day::text start, b.days, jsonb_build_object(
          'angry',count(*) filter (where t.latest_customer_sentiment = 'angry'),
          'frustrated',count(*) filter (where t.latest_customer_sentiment = 'frustrated'),
          'neutral',count(*) filter (where t.latest_customer_sentiment = 'neutral'),
          'positive',count(*) filter (where t.latest_customer_sentiment = 'positive')) counts
        from buckets b left join cohort t on t.created_at >= (b.day::timestamp at time zone 'UTC')
          and t.created_at < ((b.day + b.days)::timestamp at time zone 'UTC') group by b.day,b.days) x)
    ) report
  `;
  const report = result.report;
  const eligible = report.total - (report.byStatus.closed || 0);
  report.resolved = report.byStatus.resolved || 0;
  report.resolutionRate = eligible ? Math.round(report.resolved / eligible * 100) : 0;
  report.slaCompliance = eligible ? Math.round((report.slaOk + report.slaWarn) / eligible * 100) : 0;
  return { period, report };
}
