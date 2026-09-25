import type { TransactionSql } from 'postgres';

// Called inside the note update transaction, after locking the parent and note.
export async function recordNoteRevision(sql: TransactionSql, input: {
  workspaceId: string; actorId: string; parentId: string; noteId: string;
  authorId: string | null; kind: 'ticket' | 'customer'; before: string; after: string; beforeHtml?: string | null;
}) {
  const { workspaceId, actorId, parentId, noteId, kind, before, after, beforeHtml } = input;
  const [editor] = await sql`select name from users where id = ${actorId}`;
  const [revision] = await sql`insert into note_revisions
    (workspace_id, ticket_message_id, customer_note_id, editor_user_id, editor_label, before_text, after_text, before_html)
    values (${workspaceId}, ${kind === 'ticket' ? noteId : null}, ${kind === 'customer' ? noteId : null},
      ${actorId}, ${editor?.name || 'Unknown'}, ${before}, ${after}, ${beforeHtml || null}) returning id`;
  await sql`insert into audit_events (workspace_id, actor_user_id, action, target_type, target_id, metadata)
    values (${workspaceId}, ${actorId}, ${kind + '_note.edited'}, ${kind === 'ticket' ? 'ticket_message' : 'customer_note'}, ${noteId},
      ${sql.json({ revision_id: revision.id, author_user_id: input.authorId, [kind + '_id']: parentId, previous_length: before.length, length: after.length })})`;
}
