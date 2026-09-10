import type { TransactionSql } from 'postgres';

export function snoozeState(ticket: { snoozed_until?: string | Date | null; snooze_reason?: string | null }) {
  return ticket.snoozed_until ? JSON.stringify({ until: new Date(ticket.snoozed_until).toISOString(), reason: ticket.snooze_reason || null }) : null;
}

// The caller holds the ticket row lock. History and the change must commit
// together; deliberately do not use the best-effort administrative audit helper.
export async function recordTicketActivity(sql: TransactionSql, input: {
  workspaceId: string; ticketId: string; actorId: string | null;
  kind: 'agent' | 'priority' | 'tag' | 'status' | 'snooze'; before: string | null; after: string | null;
  source?: 'customer_reply' | 'assignment_rule' | 'snooze_expired' | 'close' | 'merge' | 'unmerge';
  context?: Record<string, string | null>;
}) {
  if (input.before === input.after) return [];
  const { workspaceId, ticketId, actorId, kind, before, after } = input;
  const [actor] = actorId ? await sql`select name from users where id = ${actorId}` : [];
  const author = actorId ? actor?.name || 'Former agent' : input.source === 'customer_reply' ? 'Customer reply' : 'System';
  let beforeLabel = before, afterLabel = after;
  if (kind === 'snooze') {
    const label = (value: string | null) => {
      if (!value) return 'Not snoozed';
      const state = JSON.parse(value);
      return `${state.until}${state.reason ? ' · ' + state.reason : ''}`;
    };
    beforeLabel = label(before); afterLabel = label(after);
  }
  if (kind === 'agent') {
    const ids = [before, after].filter((id): id is string => Boolean(id));
    const users = ids.length ? await sql`select id, name from users where id in ${sql(ids)}` : [];
    const label = (id: string | null) => id ? users.find(u => u.id === id)?.name || 'Former agent' : 'Unassigned';
    beforeLabel = label(before); afterLabel = label(after);
  }
  const change = kind === 'tag'
    ? after === null ? `Tag removed: ${before}` : `Tagged: ${after}`
    : `${({ agent: 'Assigned', priority: 'Priority', status: 'Status', snooze: 'Snooze' })[kind]}: ${beforeLabel || 'None'} → ${afterLabel || 'None'}`;
  const source = input.source === 'assignment_rule' ? `Rule: ${input.context?.rule_name}`
    : input.source === 'customer_reply' ? 'Customer replied'
    : input.source === 'snooze_expired' ? 'Snooze expired'
    : input.source === 'merge' ? 'Ticket merged'
    : input.source === 'unmerge' ? 'Merge undone' : null;
  const details = source ? `${change} (${source})` : change;
  const [event] = await sql`insert into events
    (workspace_id, entity_type, entity_id, kind, author_user_id, author_label, details, created_at)
    values (${workspaceId}, 'ticket', ${ticketId}, ${kind}, ${actorId}, ${author}, ${details}, clock_timestamp())
    returning id, kind, author_user_id, author_label, details,
      to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;
  await sql`insert into audit_events (workspace_id, actor_user_id, action, target_type, target_id, metadata, created_at)
    values (${workspaceId}, ${actorId}, ${`ticket.${kind}.changed`}, 'ticket', ${ticketId},
      ${sql.json({ event_id: event.id, actor_label: author, before, after, before_label: beforeLabel, after_label: afterLabel,
        source: input.source || 'agent', context: input.context || {} })},
      ${event.created_at})`;
  return [event];
}
