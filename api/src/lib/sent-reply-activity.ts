import type { Sql } from 'postgres';

// Read the saved delivery evidence so historical replies appear without invented audit events.
export function sentReplyActivity(sql: Sql, workspaceId: string, ticketId?: string) {
  return sql`select m.id,m.ticket_id as entity_id,'sent'::text as kind,m.author_user_id,m.author_label,
      'Reply sent by email'::text as details,coalesce((m.email_metadata->>'sent_at')::timestamptz,m.created_at) as created_at
    from ticket_messages m where m.workspace_id=${workspaceId} and m.role='agent'
      and m.deleted_at is null and m.body<>'[erased]' and m.merged_from_id is null
      and cardinality(m.forwarded_from_ticket_ids)=0 and m.email_metadata->>'status'='sent'
      ${ticketId ? sql`and m.ticket_id=${ticketId}` : sql``}`;
}
