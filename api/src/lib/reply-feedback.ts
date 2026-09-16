import { getDb } from './db.js';
import type { ReplyExample } from './previous-replies.js';

// Lock eligible target/source customers and tickets while creating the snapshot.
// Concurrent erasure waits, then the deletion triggers purge the new snapshot.
export async function recordReplySuggestion(workspaceId: string, userId: string, ticketId: string,
  reply: string, examples: ReplyExample[] = []) {
  const sql = getDb();
  return sql.begin(async tx => {
    const replyIds = examples.map(e => e.replyId);
    const tickets = await tx`select t.id from tickets t
      join customers c on c.id=t.customer_id and c.workspace_id=t.workspace_id
      where t.workspace_id=${workspaceId} and t.deleted_at is null and t.merged_into_id is null
        and c.deleted_at is null and c.erased_at is null
        and (t.id=${ticketId} or t.id in (select ticket_id from ticket_messages
          where workspace_id=${workspaceId} and id=any(${replyIds}::uuid[]) and deleted_at is null))
      order by t.id for share of t,c`;
    if (!tickets.some(t => t.id === ticketId) || tickets.length !== examples.length + 1) return null;
    const [row] = await tx`insert into ai_reply_suggestions(workspace_id,user_id,ticket_id,reply)
      values (${workspaceId},${userId},${ticketId},${reply}) returning id`;
    for (const t of tickets) if (t.id !== ticketId) {
      await tx`insert into ai_reply_suggestion_sources(suggestion_id,ticket_id) values (${row.id},${t.id})`;
    }
    return row.id as string;
  });
}
