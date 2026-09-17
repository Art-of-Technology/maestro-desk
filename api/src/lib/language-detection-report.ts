import { z } from 'zod';
import { getDb } from './db.js';

export const LanguageDetectionRange = z.enum(['7d', '30d', '90d', 'all']);
export type LanguageDetectionRange = z.infer<typeof LanguageDetectionRange>;

const rangeDays: Record<LanguageDetectionRange, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  all: 0,
};

export async function languageDetectionReport(workspaceId: string, range: LanguageDetectionRange) {
  const sql = getDb();
  const days = rangeDays[range];
  const [summaryRows, reasonRows, trendRows] = await Promise.all([
    sql`
      select count(*)::int as attempts,
             count(*) filter (where outcome <> 'success')::int as failures,
             count(*) filter (where failure_code = 'provider_error')::int as provider_failures,
             count(*) filter (where outcome = 'indeterminate')::int as indeterminate,
             count(distinct ticket_id) filter (where outcome <> 'success' and ticket_id is not null)::int as affected_tickets,
             (select min(all_detections.created_at)
                from ai_usage_log all_detections
               where all_detections.workspace_id = ${workspaceId}
                 and all_detections.action = 'detect_language'
                 and all_detections.outcome is not null) as recording_since
      from ai_usage_log
      where workspace_id = ${workspaceId}
        and action = 'detect_language'
        and outcome is not null
        and (${days} = 0 or created_at >= now() - make_interval(days => ${days}))
    `,
    sql`
      select failure_code as code, count(*)::int as count
      from ai_usage_log
      where workspace_id = ${workspaceId}
        and action = 'detect_language'
        and outcome is not null
        and outcome <> 'success'
        and (${days} = 0 or created_at >= now() - make_interval(days => ${days}))
      group by failure_code
      order by count desc, failure_code
    `,
    sql`
      select date_trunc(
               case when ${range} = 'all' then 'month'
                    when ${range} = '90d' then 'week'
                    else 'day' end,
               created_at at time zone 'UTC'
             ) as bucket,
             count(*)::int as attempts,
             count(*) filter (where outcome <> 'success')::int as failures
      from ai_usage_log
      where workspace_id = ${workspaceId}
        and action = 'detect_language'
        and outcome is not null
        and (${days} = 0 or created_at >= now() - make_interval(days => ${days}))
      group by bucket
      order by bucket desc
      limit 121
    `,
  ]);
  const summary = summaryRows[0];
  const attempts = Number(summary.attempts);
  const failures = Number(summary.failures);
  return {
    range,
    summary: {
      attempts,
      failures,
      successes: attempts - failures,
      providerFailures: Number(summary.provider_failures),
      indeterminate: Number(summary.indeterminate),
      affectedTickets: Number(summary.affected_tickets),
      failureRate: attempts ? Math.round((failures / attempts) * 1000) / 10 : 0,
      recordingSince: summary.recording_since,
    },
    reasons: reasonRows.map(row => ({ code: row.code, count: Number(row.count) })),
    trend: trendRows.slice(0, 120).reverse().map(row => ({
      bucket: row.bucket,
      attempts: Number(row.attempts),
      failures: Number(row.failures),
    })),
    trendTruncated: trendRows.length > 120,
  };
}
