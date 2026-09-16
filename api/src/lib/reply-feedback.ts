import { getDb } from './db.js';
import type { ReplyExample } from './previous-replies.js';

// Lock eligible target/source customers and tickets while creating the snapshot.
// Concurrent erasure waits, then the deletion triggers purge the new snapshot.
export async function recordReplySuggestion(workspaceId: string, userId: string, ticketId: string,
  reply: string, examples: ReplyExample[] = [], tracking?: { context?: 'reply' | 'note'; costMicro: number }): Promise<string | null> {
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
    const [row] = await tx`insert into ai_reply_suggestions(workspace_id,user_id,ticket_id,reply,reply_context,generation_cost_micro)
      values (${workspaceId},${userId},${ticketId},${reply},${tracking?.context || null},${tracking?.context ? tracking.costMicro : null}) returning id`;
    for (const t of tickets) if (t.id !== ticketId) {
      await tx`insert into ai_reply_suggestion_sources(suggestion_id,ticket_id) values (${row.id},${t.id})`;
    }
    return row.id as string;
  });
}

// Only an explicitly confirmed use, posted by the generating agent to the same
// ticket, can become the first use. No client-supplied timing or change flag.
export async function recordReplyUse(workspaceId: string, userId: string, ticketId: string, suggestionId: string, messageId: string) {
  const sql = getDb();
  await sql`update ai_reply_suggestions s set sent_message_id=m.id,
      sent_changed=(regexp_replace(trim(s.reply),'\\s+',' ','g') <> regexp_replace(trim(m.body),'\\s+',' ','g'))
    from ticket_messages m where s.id=${suggestionId} and s.workspace_id=${workspaceId}
      and s.ticket_id=${ticketId} and s.user_id=${userId} and s.reply_context='reply'
      and s.sent_message_id is null and m.id=${messageId} and m.workspace_id=${workspaceId}
      and m.ticket_id=${ticketId} and m.author_user_id=${userId} and m.role='agent'
      and m.deleted_at is null and m.merged_from_id is null and m.created_at>=s.created_at`;
}
