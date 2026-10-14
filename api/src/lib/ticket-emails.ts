import { HTTPException } from 'hono/http-exception';
import { getDb } from './db.js';
import { ticketPrivacy, requireTicketPrivacy } from './ticket-privacy.js';
import { workspaceAccessGeneration, requireAvailableWorkspace } from './workspace-access.js';
import { chronologicalEmails, MAX_EXPORT_MESSAGES, type ExportEmail, type ExportAttachment } from './email-export.js';

// Read original records behind merges: the historical display copies omit
// attachments, HTML, transport ids and the original creation date.
async function sources(workspaceId: string, ticketId: string) {
  return getDb()`with recursive thread as (
      select id from tickets where workspace_id=${workspaceId} and id=${ticketId}
      union
      select t.id from tickets t join thread p on t.merged_into_id=p.id where t.workspace_id=${workspaceId}
    )
    select t.id,t.merged_into_id,t.privacy_generation::text as generation,
      (t.deleted_at is null and c.deleted_at is null and c.erased_at is null) as available
    from thread join tickets t on t.id=thread.id and t.workspace_id=${workspaceId}
    join customers c on c.id=t.customer_id and c.workspace_id=${workspaceId}
    order by t.id limit 101`;
}

export async function loadTicketEmails(ws: string, ticketId: string, messageId?: string) {
    const generation = await workspaceAccessGeneration(ws);
    const privacy = await ticketPrivacy(ws, [ticketId]);
    const snapshot = await sources(ws, ticketId);
    if (snapshot.length > 100) throw new HTTPException(413, { message: 'This ticket has too many merged tickets to download.' });
    if (snapshot.some(t => !t.available)) throw new HTTPException(409, { message: 'An original merged ticket is no longer available. Its email history cannot be downloaded.' });
    const ticketIds = snapshot.map(t => t.id as string);
    const sql = getDb();
    await sql`select assert_ticket_content(${ws}::uuid,${ticketIds}::uuid[])`;
    let selectedId: string | null = null;
    if (messageId) {
      const [selected] = await sql<Pick<ExportEmail, 'id' | 'role' | 'author_label' | 'body' | 'email_metadata' | 'merged_from_id'>[]>`select m.id,m.role,m.author_label,m.body,m.email_metadata,m.merged_from_id
        from ticket_messages m where m.workspace_id=${ws} and m.ticket_id=${ticketId} and m.id=${messageId} and m.deleted_at is null`;
      if (!selected) throw new HTTPException(404, { message: 'Email not found.' });
      selectedId = selected.id;
      if (selected.merged_from_id) {
        const branch = new Set<string>([selected.merged_from_id]);
        for (let i = 0; i < snapshot.length; i++) for (const t of snapshot) if (branch.has(t.merged_into_id)) branch.add(t.id);
        const originals = await sql<{ id: string }[]>`select id from ticket_messages
          where workspace_id=${ws} and ticket_id=any(${[...branch]}::uuid[]) and ticket_id=any(${ticketIds}::uuid[])
            and deleted_at is null and merged_from_id is null and role=${selected.role}
            and body=${selected.body} and author_label is not distinct from ${selected.author_label}
            and email_metadata is not distinct from ${selected.email_metadata ? sql.json(selected.email_metadata) : null}::jsonb limit 2`;
        if (originals.length !== 1) throw new HTTPException(409, { message: 'This older merged copy cannot be matched to one original email. Download the full thread instead.' });
        selectedId = originals[0].id;
      }
    }
    const rows = await sql<ExportEmail[]>`select m.id,m.ticket_id,m.role,m.author_label,m.body,m.body_html,m.sent_email,m.forwarded_from_ticket_ids,
        m.external_message_id,m.email_metadata,m.created_at,m.merged_from_id,t.subject
      from ticket_messages m join tickets t on t.id=m.ticket_id and t.workspace_id=m.workspace_id
      where m.workspace_id=${ws} and m.ticket_id=any(${ticketIds}::uuid[]) and m.deleted_at is null
        and m.merged_from_id is null and m.role in ('customer','agent','ai')
        and (${selectedId}::uuid is null or m.id=${selectedId}::uuid)
        and (case when m.email_metadata->>'status' is not null
          then (m.role='customer' and m.email_metadata->>'status'='received') or (m.role in ('agent','ai') and m.email_metadata->>'status'='sent')
          else nullif(m.external_message_id,'') is not null end)
      order by m.created_at,m.id limit ${MAX_EXPORT_MESSAGES + 1}`;
    const emails = chronologicalEmails(rows);
    if (!emails.length) throw new HTTPException(404, { message: 'No saved, sent or received emails are available to download.' });
    const attachments = await sql<ExportAttachment[]>`select id,ticket_id,message_id,filename,size_bytes,mime_type,is_inline,content_id,disposition,storage_key
      from ticket_attachments where workspace_id=${ws} and ticket_id=any(${ticketIds}::uuid[])
        and message_id=any(${emails.map(m => m.id)}::uuid[]) order by id`;
    return { emails, attachments, privacy, generation, requireCurrent: async () => {
    await requireAvailableWorkspace(ws, generation);
    await requireTicketPrivacy(ws, privacy);
    await sql`select assert_ticket_content(${ws}::uuid,${ticketIds}::uuid[])`;
    if (JSON.stringify(await sources(ws, ticketId)) !== JSON.stringify(snapshot)) throw new HTTPException(409, { message: 'The ticket history changed. Reload it before downloading.' });
    } };
}
