import { safeError } from './diagnostics.js';
import { getDb } from './db.js';
import { alertCronFailure } from './cron-jobs.js';
import { dispatchTicketEvent } from './outgoing-webhooks.js';
import { createSnoozeWorker } from './snooze-worker.js';

// Finds tickets that have just gone past their SLA target and tells outgoing
// webhooks once per ticket (event sla.breach, data.target says which target).
//
// The clock here runs around the clock (24/7). The ticket screen can pause
// its own clock outside business hours, so the two may disagree; the webhook
// form labels the event accordingly.
//
// A ticket's policy is chosen the way the screen chooses it: an active policy
// with the same priority, the one naming the ticket's category first, then
// the catch-all (category_key null). Category labels differ in casing between
// layers, so they are compared case-insensitively.
//
//   first response: the customer has written, and either nobody has replied
//                   and the ticket's age has reached the target, or the first
//                   reply took longer than the target;
//   resolution:     the ticket's age has reached the target.
//
// Closed, resolved, merged, deleted and currently snoozed tickets are left
// alone, as are suspended or deleted brands. A ticket with a row in
// ticket_sla_breach_notices has been announced (or predates the feature) and
// is never announced again, including after it is reopened.
export async function processSlaBreaches(signal?: AbortSignal) {
  const sql = getDb();
  const candidates = await sql<{ id: string; workspace_id: string; target: 'first_response' | 'resolution' }[]>`
    select id, workspace_id, case when first_response_breached then 'first_response' else 'resolution' end as target
    from (
      select t.id, t.workspace_id, t.created_at,
        (fc.first_customer_at is not null and (
          (fr.first_agent_reply_at is null and now() - t.created_at >= p.first_response_min * interval '1 minute')
          or fr.first_agent_reply_at - fc.first_customer_at > p.first_response_min * interval '1 minute'
        )) as first_response_breached,
        (now() - t.created_at >= p.resolution_min * interval '1 minute') as resolution_breached
      from tickets t
      join workspaces w on w.id = t.workspace_id and w.deleted_at is null and w.suspended_at is null
      join lateral (
        select sp.first_response_min, sp.resolution_min from sla_policies sp
        where sp.workspace_id = t.workspace_id and sp.status = 'active' and sp.priority_key = t.priority_key
          and (sp.category_key is null or lower(sp.category_key) = lower(t.category_key))
        order by (sp.category_key is null), sp.created_at, sp.id limit 1
      ) p on true
      left join lateral (
        select min(tm.created_at) as first_customer_at from ticket_messages tm
        where tm.ticket_id = t.id and tm.role = 'customer' and tm.deleted_at is null and tm.merged_from_id is null
      ) fc on true
      left join lateral (
        select min(tm.created_at) as first_agent_reply_at from ticket_messages tm
        where tm.ticket_id = t.id and tm.role in ('agent', 'ai') and cardinality(tm.forwarded_from_ticket_ids) = 0
          and tm.deleted_at is null and tm.merged_from_id is null and tm.created_at >= fc.first_customer_at
      ) fr on true
      where t.deleted_at is null and t.merged_into_id is null
        and t.status_key not in ('closed', 'resolved')
        and (t.snoozed_until is null or t.snoozed_until <= now())
        and not exists (select 1 from ticket_sla_breach_notices n where n.ticket_id = t.id)
    ) due
    where first_response_breached or resolution_breached
    order by created_at, id limit 100`;
  let processed = 0, failed = 0;
  const deadline = Date.now() + 30_000;
  for (const row of candidates) {
    if (signal?.aborted || Date.now() >= deadline) break;
    try {
      // Claim first: whichever sweep inserts the row owns the announcement.
      const [claimed] = await sql`
        insert into ticket_sla_breach_notices (ticket_id, workspace_id, target)
        values (${row.id}, ${row.workspace_id}, ${row.target})
        on conflict (ticket_id) do nothing returning ticket_id`;
      if (!claimed) continue;
      try {
        await dispatchTicketEvent({ workspaceId: row.workspace_id, event: 'sla.breach', ticketId: row.id,
          extra: { target: row.target } });
      } catch (error) {
        // Give the claim back so the next sweep tries again.
        await sql`delete from ticket_sla_breach_notices where ticket_id = ${row.id}`;
        throw error;
      }
      processed++;
    } catch (error) {
      failed++;
      console.error('[sla-breach-worker] ticket failed:', safeError(error));
    }
  }
  return { processed, failed, scanned: candidates.length };
}

// Started by the long-running server entries only (src/server.ts, src/dev.ts).
export const slaBreachWorker = createSnoozeWorker(processSlaBreaches,
  (error: unknown) => alertCronFailure('sla-breach', error), 'sla-breach-worker');
