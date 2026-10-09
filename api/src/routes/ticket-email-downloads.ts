import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { getDb } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';
import { enforceRateLimit } from '../lib/rate-limit.js';
import { attachmentsStore, contentDispositionFor, isAttachmentsStorageConfigured } from '../lib/r2.js';
import { buildEmailDownload } from '../lib/email-export.js';
import { loadTicketEmails } from '../lib/ticket-emails.js';

export const ticketEmailDownloads = new Hono();
let activeDownloads = 0;
const querySchema = z.object({ format: z.enum(['pdf', 'eml']), messageId: z.string().uuid().optional(), remoteImages: z.enum(['true', 'false']).optional() });

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
    const sql = getDb();
    const {emails,attachments,requireCurrent} = await loadTicketEmails(ws,id.data,messageId);
    const [workspace] = await sql`select logo_url from workspaces where id=${ws}`;
    const bytes = await buildEmailDownload(emails, attachments, format, Boolean(messageId), async key => {
      if (!isAttachmentsStorageConfigured()) throw new HTTPException(503, { message: 'Attachment storage is unavailable. Try again later.' });
      try { return (await attachmentsStore().getObject(key)).bytes; }
      catch { throw new HTTPException(503, { message: 'An attachment could not be downloaded. Try again later.' }); }
    }, { remoteImages: parsed.data.remoteImages === 'true', logoUrl: workspace?.logo_url });
    // Erasure, suspension, unmerge or an access change while fetching private
    // files must invalidate the finished download, not release stale content.
    await requireCurrent();
    await requireAuth(c, async () => {});
    const extension = format === 'pdf' ? 'pdf' : messageId ? 'eml' : 'zip';
    return new Response(new Uint8Array(bytes), { headers: {
      'Content-Type': format === 'pdf' ? 'application/pdf' : messageId ? 'message/rfc822' : 'application/zip',
      'Content-Disposition': contentDispositionFor('attachment', `ticket-${id.data}${messageId ? `-${messageId}` : '-thread'}.${extension}`),
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    } });
  } finally { activeDownloads--; }
});
