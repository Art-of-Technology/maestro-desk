import { z } from 'zod';
import { getDb } from './db.js';
import { parseReportPeriod } from './dashboard-report.js';

export const ReplyPerformanceQuery = z.object({
  start: z.string(), end: z.string(),
  agent: z.string().max(100).default(''),
  reason: z.enum(['all','none','wrong_match','outdated_advice','wrong_language','other']).default('all'),
  rating: z.enum(['all','helpful','not_helpful','unrated']).default('all'),
  language:z.string().max(100).default(''), query_type:z.string().max(200).default(''),
  outcome:z.enum(['all','accepted','substantial','rejected','unrecorded']).default('all'),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  export: z.enum(['details']).optional(),
}).strict().refine(v => {
  const period = parseReportPeriod(v.start,v.end);
  return period && +new Date(period.end)-+new Date(period.start) <= 366*86400000;
}, 'Choose a valid date range of up to 366 days.');

export async function replyPerformance(workspaceId: string, query: z.infer<typeof ReplyPerformanceQuery>) {
  const sql = getDb();
  const fields = sql`
    count(*)::int as generated,
    count(*) filter(where reply_context='reply')::int as tracked,
    count(*) filter(where shown_at is not null)::int as shown,
    count(helpful)::int as rated,
    count(*) filter(where helpful=true)::int as helpful,
    count(*) filter(where helpful=false)::int as not_helpful,
    count(*) filter(where helpful=false and reason='wrong_match')::int as wrong_match,
    count(*) filter(where helpful=false and reason='outdated_advice')::int as outdated_advice,
    count(*) filter(where helpful=false and reason='wrong_language')::int as wrong_language,
    count(*) filter(where helpful=false and reason='other')::int as other,
    count(*) filter(where helpful=false and reason is null)::int as no_reason,
    count(sent_at)::int as used,
    count(*) filter(where sent_at is not null and sent_changed=true)::int as changed,
    count(*) filter(where sent_at is not null and sent_changed=false)::int as unchanged,
    count(*) filter(where sent_at is not null and sent_change_ratio>=0.3)::int as substantial,
    count(*) filter(where sent_at is not null and sent_change_ratio is null)::int as change_unavailable,
    count(*) filter(where sent_at is null and rejected_at is not null)::int as rejected,
    count(generation_cost_micro)::int as cost_known,
    coalesce(sum(generation_cost_micro),0) as cost_micro,
    percentile_cont(0.5) within group(order by elapsed_seconds) as median_seconds`;
  const [row] = await sql`
    with period as materialized (
      select s.id,s.user_id,coalesce(u.name,'Former agent') as agent_name,s.created_at,
        s.ticket_id,t.display_id,t.subject,s.reply_context,s.generation_cost_micro,s.shown_at,
        m.created_at as sent_at,s.sent_changed,s.sent_change_ratio,s.rejected_at,
        coalesce(s.reply_language,'Not recorded') as reply_language,coalesce(s.query_type,'Not recorded') as query_type,
        extract(epoch from (m.created_at-s.created_at)) as elapsed_seconds,
        f.helpful,f.reason,f.updated_at as rated_at,
        to_char(s.created_at at time zone 'UTC','YYYY-MM-DD') as day
      from ai_reply_suggestions s join tickets t on t.id=s.ticket_id and t.workspace_id=s.workspace_id
      left join users u on u.id=s.user_id
      left join ai_reply_feedback f on f.suggestion_id=s.id
      left join ticket_messages m on m.id=s.sent_message_id and m.workspace_id=s.workspace_id
        and m.ticket_id=s.ticket_id and m.role='agent' and m.deleted_at is null and m.merged_from_id is null
      where s.workspace_id=${workspaceId} and s.created_at>=${query.start}::timestamptz and s.created_at<${query.end}::timestamptz
        and s.reply_context is distinct from 'note' and t.deleted_at is null and t.merged_into_id is null
    ), cohort as materialized (
      select * from period where (${query.agent}='' or coalesce(user_id::text,'former')=${query.agent})
        and (${query.reason}='all' or (${query.reason}='none' and helpful=false and reason is null) or reason=${query.reason})
        and (${query.rating}='all' or (${query.rating}='helpful' and helpful=true)
          or (${query.rating}='not_helpful' and helpful=false) or (${query.rating}='unrated' and helpful is null))
        and (${query.language}='' or reply_language=${query.language})
        and (${query.query_type}='' or query_type=${query.query_type})
        and (${query.outcome}='all' or (${query.outcome}='accepted' and sent_at is not null)
          or (${query.outcome}='substantial' and sent_at is not null and sent_change_ratio>=0.3)
          or (${query.outcome}='rejected' and sent_at is null and rejected_at is not null)
          or (${query.outcome}='unrecorded' and sent_at is null and rejected_at is null))
    ), summary as (select ${fields} from cohort),
    agents as (select user_id,agent_name,${fields} from cohort group by user_id,agent_name),
    trend as (select day,${fields} from cohort group by day),
    languages as (select reply_language,${fields} from cohort group by reply_language),
    types as (select query_type,${fields} from cohort group by query_type),
    reasons as (select coalesce(reason,'none') as reason,count(*)::int as count from cohort where helpful=false group by reason),
    choices as (select distinct coalesce(user_id::text,'former') as id,agent_name as name from period),
    details as (select * from cohort order by created_at desc,id desc
      limit ${query.export ? 10001 : 51} offset ${query.export ? 0 : query.offset})
    select jsonb_build_object(
      'summary',(select row_to_json(summary) from summary),
      'agents',coalesce((select jsonb_agg(agents order by generated desc,agent_name,user_id) from agents),'[]'::jsonb),
      'trend',coalesce((select jsonb_agg(trend order by day) from trend),'[]'::jsonb),
      'languages',coalesce((select jsonb_agg(languages order by generated desc,reply_language) from languages),'[]'::jsonb),
      'queryTypes',coalesce((select jsonb_agg(types order by generated desc,query_type) from types),'[]'::jsonb),
      'languageOptions',coalesce((select jsonb_agg(value order by value) from (select distinct reply_language as value from period) x),'[]'::jsonb),
      'queryTypeOptions',coalesce((select jsonb_agg(value order by value) from (select distinct query_type as value from period) x),'[]'::jsonb),
      'reasons',coalesce((select jsonb_agg(reasons order by count desc,reason) from reasons),'[]'::jsonb),
      'agentOptions',coalesce((select jsonb_agg(choices order by name,id) from choices),'[]'::jsonb),
      'details',coalesce((select jsonb_agg(details order by created_at desc,id desc) from details),'[]'::jsonb)
    ) as report`;
  const report = row.report;
  if (query.export && report.summary.generated > 10000) return null;
  report.hasMore = !query.export && report.details.length > 50;
  if (!query.export) report.details = report.details.slice(0,50);
  return report;
}
