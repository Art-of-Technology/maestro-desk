import { z } from 'zod';
import { getDb } from './db.js';

export const AgentReportQuery = z.object({
  range: z.enum(['7d', '30d', '90d', 'all']).default('30d'),
  agentId: z.string().uuid().optional(),
});

export async function agentReport(workspaceId: string, query: z.infer<typeof AgentReportQuery>, end = new Date()) {
  const sql = getDb();
  const start = query.range === 'all' ? null : new Date(end.getTime() - parseInt(query.range) * 86400000);
  const [result] = await sql`
    with scoped as materialized (
      select * from tickets where workspace_id = ${workspaceId} and deleted_at is null and merged_into_id is null
    ), resolutions as materialized (
      select a.target_id ticket_id, a.actor_user_id user_id, a.created_at
      from audit_events a join scoped t on t.id = a.target_id
      where a.workspace_id = ${workspaceId} and a.action = 'ticket.status.changed' and a.target_type = 'ticket'
        and a.metadata->>'after' = 'resolved' and a.metadata->>'before' is distinct from 'resolved'
        and a.metadata->>'source' = 'agent' and a.actor_user_id is not null
        and a.created_at < ${end}
    ), messages as materialized (
      select m.* from ticket_messages m join scoped t on t.id = m.ticket_id
      where m.workspace_id = ${workspaceId} and m.deleted_at is null and m.merged_from_id is null and cardinality(m.forwarded_from_ticket_ids)=0
    ), activity as materialized (
      select ticket_id, author_user_id user_id, role, left(body, 200) body, created_at from messages
      where role in ('agent','ai','note') and author_user_id is not null
        and (${start}::timestamptz is null or created_at >= ${start}) and created_at < ${end}
      union all
      select ticket_id, user_id, 'resolved', 'Resolved ticket', created_at from resolutions
      where ${start}::timestamptz is null or created_at >= ${start}
    ), handled as materialized (
      select user_id, ticket_id, max(created_at) last_activity from activity group by user_id, ticket_id
    ), ratings as materialized (
      select distinct on (t.id) t.id, t.csat_score, r.user_id from scoped t
      join resolutions r on r.ticket_id = t.id and r.created_at <= t.csat_submitted_at
      where t.csat_score is not null and t.csat_submitted_at < ${end}
        and (${start}::timestamptz is null or t.csat_submitted_at >= ${start})
      order by t.id, r.created_at desc
    ), first_customer as (
      select ticket_id, min(created_at) created_at from messages where role = 'customer' group by ticket_id
    ), first_reply as (
      select distinct on (m.ticket_id) m.author_user_id user_id, m.created_at,
        extract(epoch from (m.created_at - fc.created_at))/60 minutes
      from messages m join first_customer fc on fc.ticket_id = m.ticket_id and m.created_at >= fc.created_at
      where m.role in ('agent','ai') order by m.ticket_id,m.created_at,m.id
    ), first_replies as (
      select * from first_reply where created_at < ${end} and (${start}::timestamptz is null or created_at >= ${start})
    ), summaries as (
      select wm.user_id as "userId",
        (select count(*)::int from scoped t where t.assigned_user_id = wm.user_id and t.status_key not in ('resolved','closed')) as open,
        (select count(*)::int from handled h where h.user_id = wm.user_id) as total,
        (select count(distinct ticket_id)::int from activity a where a.user_id = wm.user_id and role = 'resolved') as resolved,
        (select count(*)::int from activity a where a.user_id = wm.user_id and role in ('agent','ai')) as replies,
        (select count(*)::int from ratings r where r.user_id = wm.user_id) as "csatCount",
        (select coalesce(avg(csat_score),0)::float from ratings r where r.user_id = wm.user_id) as "avgCSAT",
        (select avg(minutes)::float from first_replies f where f.user_id = wm.user_id) as "avgResponseMin"
      from workspace_members wm where workspace_id = ${workspaceId}
    ), detail_tickets as materialized (
      select t.*, h.last_activity from handled h join scoped t on t.id = h.ticket_id where h.user_id = ${query.agentId || null}::uuid
    )
    select (select coalesce(jsonb_agg(to_jsonb(s)), '[]') from summaries s) summaries,
      jsonb_build_object(
        'byStatus', (select coalesce(jsonb_object_agg(k,n),'{}') from (select status_key k,count(*) n from detail_tickets group by 1) x),
        'byPriority', (select coalesce(jsonb_object_agg(k,n),'{}') from (select priority_key k,count(*) n from detail_tickets group by 1) x),
        'byCategory', (select coalesce(jsonb_object_agg(k,n),'{}') from (select coalesce(category_key,'Other') k,count(*) n from detail_tickets group by 1) x),
        'csatBuckets', (select jsonb_agg(n order by score) from (select score,(select count(*) from ratings where user_id = ${query.agentId || null}::uuid and csat_score = score) n from generate_series(1,5) score) x),
        'topCustomers', (select coalesce(jsonb_agg(x),'[]') from (select jsonb_build_object('id',c.display_id,'first',coalesce(c.first_name,''),'last',coalesce(c.last_name,'')) cust,count(*)::int count
          from detail_tickets t join customers c on c.id = t.customer_id and c.workspace_id = ${workspaceId} group by c.id order by count(*) desc,c.id limit 5) x),
        'topTags', (select coalesce(jsonb_agg(jsonb_build_array(tag,n)),'[]') from (select tt.tag,count(*) n from detail_tickets t join ticket_tags tt on tt.ticket_id = t.id and tt.workspace_id = ${workspaceId} group by tt.tag order by count(*) desc,tt.tag limit 10) x),
        'recent', (select coalesce(jsonb_agg(x),'[]') from (select t.display_id as "ticketId",a.role,a.body as text,a.created_at as ts from activity a join scoped t on t.id = a.ticket_id
          where a.user_id = ${query.agentId || null}::uuid order by a.created_at desc,t.id limit 8) x),
        'tickets', (select coalesce(jsonb_agg(x),'[]') from (select t.display_id id,t.subject,t.status_key status,t.priority_key priority,t.sla_state sla,t.updated_at updated,
          concat_ws(' ',c.first_name,c.last_name) as "customerName"
          from detail_tickets t left join customers c on c.id = t.customer_id and c.workspace_id = ${workspaceId}
          order by t.last_activity desc,t.id limit 50) x)
      ) detail
  `;
  return { period: { start: start?.toISOString() || null, end: end.toISOString(), range: query.range }, summaries: result.summaries, detail: result.detail };
}
