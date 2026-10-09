import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { getDb } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';
import { ticketPrivacy, requireTicketPrivacy } from '../lib/ticket-privacy.js';
import { workspaceAccessGeneration, requireAvailableWorkspace } from '../lib/workspace-access.js';
import { enforceRateLimit } from '../lib/rate-limit.js';
import { attachmentsStore, contentDispositionFor, isAttachmentsStorageConfigured } from '../lib/r2.js';
import { buildEmailDownload, chronologicalEmails, MAX_EXPORT_MESSAGES, type ExportEmail, type ExportAttachment } from '../lib/email-export.js';

export const ticketEmailDownloads = new Hono();
let activeDownloads = 0;
const querySchema = z.object({ format: z.enum(['pdf', 'eml']), messageId: z.string().uuid().optional() });

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

ticketEmailDownloads.get('/:id/emails/download', async c => {
  const parsed = querySchema.safeParse(c.req.query());
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!parsed.success || !id.success) return c.json({ error: 'Choose a valid ticket, email and download format.' }, 400);
  const { format, messageId } = parsed.data;
  const ws = c.get('workspaceId');
  const limited = await enforceRateLimit(c, { name: 'ticket-email-download', by: `${ws}:${c.get('userId')}`, max: 10, windowSeconds: 60, failClosed: true });
  if (limited) return limited;
  if (activeDownloads >= 2) return c.json({ error: 'Downloads are busy. Try again shortly.' }, 429, { 'Retry-After': '5' });
  activeDownloads++;
  try {
    const generation = await workspaceAccessGeneration(ws);
    const privacy = await ticketPrivacy(ws, [id.data]);
    const snapshot = await sources(ws, id.data);
    if (snapshot.length > 100) throw new HTTPException(413, { message: 'This ticket has too many merged tickets to download.' });
    if (snapshot.some(t => !t.available)) throw new HTTPException(409, { message: 'An original merged ticket is no longer available. Its email history cannot be downloaded.' });
    const ticketIds = snapshot.map(t => t.id as string);
    const sql = getDb();
    await sql`select assert_ticket_content(${ws}::uuid,${ticketIds}::uuid[])`;
    let selectedId: string | null = null;
    if (messageId) {
      const [selected] = await sql<Pick<ExportEmail, 'id' | 'role' | 'author_label' | 'body' | 'email_metadata' | 'merged_from_id'>[]>`select m.id,m.role,m.author_label,m.body,m.email_metadata,m.merged_from_id
        from ticket_messages m where m.workspace_id=${ws} and m.ticket_id=${id.data} and m.id=${messageId} and m.deleted_at is null`;
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
    const rows = await sql<ExportEmail[]>`select m.id,m.ticket_id,m.role,m.author_label,m.body,m.body_html,
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
    const bytes = await buildEmailDownload(emails, attachments, format, Boolean(messageId), async key => {
      if (!isAttachmentsStorageConfigured()) throw new HTTPException(503, { message: 'Attachment storage is unavailable. Try again later or choose PDF.' });
      try { return (await attachmentsStore().getObject(key)).bytes; }
      catch { throw new HTTPException(503, { message: 'An attachment could not be downloaded. Try again later or choose PDF.' }); }
    });
    // Erasure, suspension, unmerge or an access change while fetching private
    // files must invalidate the finished download, not release stale content.
    await requireAvailableWorkspace(ws, generation);
    await requireTicketPrivacy(ws, privacy);
    await sql`select assert_ticket_content(${ws}::uuid,${ticketIds}::uuid[])`;
    if (JSON.stringify(await sources(ws, id.data)) !== JSON.stringify(snapshot)) throw new HTTPException(409, { message: 'The ticket history changed. Reload it before downloading.' });
    await requireAuth(c, async () => {});
    const extension = format === 'pdf' ? 'pdf' : messageId ? 'eml' : 'zip';
    return new Response(new Uint8Array(bytes), { headers: {
      'Content-Type': format === 'pdf' ? 'application/pdf' : messageId ? 'message/rfc822' : 'application/zip',
      'Content-Disposition': contentDispositionFor('attachment', `ticket-${id.data}${messageId ? `-${messageId}` : '-thread'}.${extension}`),
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    } });
  } finally { activeDownloads--; }
});
