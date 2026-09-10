import type { TransactionSql } from 'postgres';

// The caller holds the ticket row lock. History and the change must commit
// together; deliberately do not use the best-effort administrative audit helper.
export async function recordTicketActivity(sql: TransactionSql, input: {
  workspaceId: string; ticketId: string; actorId: string;
  kind: 'agent' | 'priority' | 'tag'; before: string | null; after: string | null;
}) {
  if (input.before === input.after) return [];
  const { workspaceId, ticketId, actorId, kind, before, after } = input;
  const [actor] = await sql`select name from users where id = ${actorId}`;
  const author = actor?.name || 'Former agent';
  let beforeLabel = before, afterLabel = after;
  if (kind === 'agent') {
    const ids = [before, after].filter((id): id is string => Boolean(id));
    const users = ids.length ? await sql`select id, name from users where id in ${sql(ids)}` : [];
    const label = (id: string | null) => id ? users.find(u => u.id === id)?.name || 'Former agent' : 'Unassigned';
    beforeLabel = label(before); afterLabel = label(after);
  }
  const details = kind === 'tag'
    ? after === null ? `Tag removed: ${before}` : `Tagged: ${after}`
    : `${kind === 'agent' ? 'Assigned' : 'Priority'}: ${beforeLabel || 'None'} → ${afterLabel || 'None'}`;
  const [event] = await sql`insert into events
    (workspace_id, entity_type, entity_id, kind, author_user_id, author_label, details, created_at)
    values (${workspaceId}, 'ticket', ${ticketId}, ${kind}, ${actorId}, ${author}, ${details}, clock_timestamp())
    returning id, kind, author_user_id, author_label, details,
      to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;
  await sql`insert into audit_events (workspace_id, actor_user_id, action, target_type, target_id, metadata, created_at)
    values (${workspaceId}, ${actorId}, ${`ticket.${kind}.changed`}, 'ticket', ${ticketId},
      ${sql.json({ event_id: event.id, actor_label: author, before, after, before_label: beforeLabel, after_label: afterLabel })},
      ${event.created_at})`;
  return [event];
}
