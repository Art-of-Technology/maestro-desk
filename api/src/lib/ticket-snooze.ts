import type { TransactionSql } from 'postgres';
import { recordTicketActivity, snoozeState } from './ticket-activity.js';

// Shared by manual/legacy browser wakeups and the server worker. Re-read under
// the lock so a concurrent resnooze or completion always wins before mutation.
export async function clearTicketSnooze(sql: TransactionSql, input: {
  workspaceId: string; ticketId: string; automatic: boolean; actorId: string | null; skipLocked?: boolean;
}) {
  const { workspaceId, ticketId, automatic, actorId } = input;
  const [existing] = await sql`select id, snoozed_until, snoozed_at, snoozed_by_user_id,
    snooze_reason, snooze_woken_at, updated_at,
    (snoozed_until <= clock_timestamp() and merged_into_id is null
      and status_key in ('open', 'pending', 'escalated', 'gdpr')) as eligible
    from tickets where id = ${ticketId} and workspace_id = ${workspaceId} and deleted_at is null
    for update ${input.skipLocked ? sql`skip locked` : sql``}`;
  if (!existing) return null;
  const { eligible, ...unchanged } = existing;
  if (!existing.snoozed_until || (automatic && !eligible)) return { ticket: unchanged, activity: [] };
  const [ticket] = await sql`update tickets set snoozed_until = null, snoozed_at = null,
    snoozed_by_user_id = null, snooze_reason = null,
    snooze_woken_at = ${automatic ? sql`clock_timestamp()` : null}
    where id = ${ticketId} and workspace_id = ${workspaceId}
    returning id, snoozed_until, snoozed_at, snoozed_by_user_id, snooze_reason, snooze_woken_at, updated_at`;
  const activity = await recordTicketActivity(sql, { workspaceId, ticketId, actorId: automatic ? null : actorId,
    kind: 'snooze', before: snoozeState(existing), after: null,
    ...(automatic ? { source: 'snooze_expired' as const } : {}) });
  return { ticket, activity };
}
