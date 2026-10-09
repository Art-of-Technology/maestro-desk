import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../lib/db.js';
import { attachmentsStore, contentDispositionFor } from '../lib/r2.js';
import { validPrivateFileLink } from '../lib/private-file-links.js';
import { requireAvailableWorkspace } from '../lib/workspace-access.js';
import { sniffImageMime } from '../lib/image-sniff.js';
import { enforceRateLimit } from '../lib/rate-limit.js';

export const files = new Hono();
files.get('/:kind/:id', async c => {
  const { kind, id } = c.req.param();
  if (!['attachment', 'knowledge'].includes(kind) || !z.string().uuid().safeParse(id).success)
    return c.json({ error: 'File not found' }, 404);
  const lookupLimited = await enforceRateLimit(c, { name: 'private-file-lookup', max: 600, windowSeconds: 60, failClosed: true });
  if (lookupLimited) return lookupLimited;
  const sql = getDb();
  const lookup = () => kind === 'attachment'
    ? sql`select a.workspace_id,a.storage_key,a.filename from ticket_attachments a
        join tickets t on t.id=a.ticket_id and t.workspace_id=a.workspace_id
        where a.id=${id} and a.message_id is not null and t.deleted_at is null`
    : sql`select workspace_id,storage_key,locator as filename from knowledge_sources where id=${id} and kind='file'`;
  const [row] = await lookup();
  if (!row?.storage_key || !validPrivateFileLink({ kind: kind as 'attachment' | 'knowledge', id,
    workspaceId: row.workspace_id, storageKey: row.storage_key }, c.req.query('expires') || '', c.req.query('signature') || ''))
    return c.json({ error: 'File link is invalid or expired' }, 403);
  const limited = await enforceRateLimit(c, { name: 'private-file', by: id, max: 120, windowSeconds: 60, failClosed: true });
  if (limited) return limited;
  await requireAvailableWorkspace(row.workspace_id);
  const { bytes } = await attachmentsStore().getObject(row.storage_key);
  await requireAvailableWorkspace(row.workspace_id);
  const [current] = await lookup();
  if (!current || current.storage_key !== row.storage_key || current.workspace_id !== row.workspace_id)
    return c.json({ error: 'File is no longer available' }, 403);
  const mime = sniffImageMime(bytes) || 'application/octet-stream';
  return new Response(bytes, { headers: { 'Content-Type': mime,
    'Content-Disposition': contentDispositionFor('attachment', row.filename),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
});
