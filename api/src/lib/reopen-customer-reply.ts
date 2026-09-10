import type { TransactionSql } from 'postgres';

// Lock the ticket so simultaneous replies archive each closure once. The note
// and state change commit together: a failed archive must not erase history.
export async function reopenOnCustomerReply(sql: TransactionSql, workspaceId: string, ticketId: string): Promise<void> {
  const [ticket] = await sql`select status_key, closure_reason, closure_note, closed_at, closed_by_user_id
    from tickets where id = ${ticketId} and workspace_id = ${workspaceId}
      and deleted_at is null for update`;
  if (!ticket || !['pending', 'resolved', 'closed'].includes(ticket.status_key)) return;

  if (ticket.status_key === 'closed') {
    const [actor] = ticket.closed_by_user_id
      ? await sql`select name from users where id = ${ticket.closed_by_user_id}` : [];
    const closedAt = ticket.closed_at ? new Date(ticket.closed_at).toISOString() : 'Not recorded';
    const closedBy = ticket.closed_by_user_id
      ? `${actor?.name || 'Former agent'} (${ticket.closed_by_user_id})` : 'Not recorded';
    const body = `Previous closure — reopened by customer reply\nReason: ${ticket.closure_reason || 'Not recorded'}\nClosed by: ${closedBy}\nClosed at: ${closedAt}\nNotes: ${ticket.closure_note || 'None'}`;
    await sql`insert into ticket_messages (workspace_id, ticket_id, role, author_label, body)
      values (${workspaceId}, ${ticketId}, 'note', 'System', ${body})`;
  }

  await sql`update tickets set status_key = 'open', resolved_at = null,
    closure_reason = null, closure_note = null, closed_at = null, closed_by_user_id = null
    where id = ${ticketId} and workspace_id = ${workspaceId} and deleted_at is null`;
}
