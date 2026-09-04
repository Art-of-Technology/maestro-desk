// Ticket attachments: storing inbound email files and serving them back.
//
// Objects live in the PRIVATE attachments bucket under
//   att/<workspaceId>/<ticketId>/<attachment uuid>/<sanitised filename>
// and rows in ticket_attachments (message_id = the message they belong to).
// The UI never gets a storage key — only short-lived presigned URLs minted
// here inside an authenticated ticket response.
//
// Inbound storage is best-effort per file: a blocked type, an oversize file, a
// storage outage or an unconfigured bucket SKIPS that file (the message still
// lands, with a note in its text body) — Postmark must always get its 200.

import type { Sql, TransactionSql } from 'postgres';
import { getDb } from './db.js';
import { attachmentsStore, contentDispositionFor, isAttachmentsStorageConfigured, type R2Store } from './r2.js';
import { classifyAttachment, formatSkipNote, MAX_INBOUND_FILE_BYTES, sanitizeFilename } from './attachment-policy.js';
import { rewriteCidsToUrls } from './email-html.js';

export interface PostmarkAttachment {
  Name: string;
  Content: string;         // base64
  ContentType?: string;
  ContentLength?: number;
  ContentID?: string;      // '' for regular (non-inline) attachments
}

export interface AttachmentRow {
  id: string;
  message_id: string | null;
  filename: string;
  size_bytes: number | null;
  mime_type: string | null;
  is_inline: boolean;
  content_id: string | null;
  disposition: 'inline' | 'attachment';
  storage_key: string;
}

// What the API returns per attachment. `url` is null when storage is not
// configured (metadata still shows so the agent knows a file exists).
export interface PublicAttachment {
  id: string;
  filename: string;
  size_bytes: number | null;
  mime_type: string | null;
  is_inline: boolean;
  disposition: 'inline' | 'attachment';
  url: string | null;
}

export interface StoreDeps {
  // Injectable store (tests). Default: the private attachments bucket.
  store?: R2Store;
  configured?: () => boolean;
}

export interface StoreInboundResult {
  // Raw Postmark Content-ID (angle brackets stripped) → our attachment uuid.
  cidMap: Map<string, string>;
  stored: number;
  // Human-readable notes for files we did not keep, for the message body.
  skipped: string[];
}

export function storageKeyFor(workspaceId: string, ticketId: string, attachmentId: string, filename: string): string {
  return `att/${workspaceId}/${ticketId}/${attachmentId}/${filename}`;
}

/**
 * Upload every acceptable Postmark attachment and insert its row. Never
 * throws for a per-file problem — each is reported in `skipped`.
 */
export async function storeInboundAttachments(
  sql: Sql | TransactionSql,
  args: { workspaceId: string; ticketId: string; messageId: string; attachments: PostmarkAttachment[] | undefined },
  deps: StoreDeps = {},
): Promise<StoreInboundResult> {
  const result: StoreInboundResult = { cidMap: new Map(), stored: 0, skipped: [] };
  const list = args.attachments ?? [];
  if (list.length === 0) return result;

  const configured = deps.configured ?? isAttachmentsStorageConfigured;
  if (!deps.store && !configured()) {
    console.warn(`[attachments] ${list.length} inbound file(s) dropped — R2_ATTACHMENTS_BUCKET is not configured`);
    for (const a of list) result.skipped.push(formatSkipNote(a.Name, 'attachment storage not configured'));
    return result;
  }
  const store = deps.store ?? attachmentsStore();

  for (const a of list) {
    const filename = sanitizeFilename(a.Name);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(Buffer.from(a.Content ?? '', 'base64'));
    } catch {
      result.skipped.push(formatSkipNote(filename, 'unreadable content'));
      continue;
    }
    const verdict = classifyAttachment(filename, a.ContentType, bytes, MAX_INBOUND_FILE_BYTES);
    if (!verdict.ok) {
      result.skipped.push(formatSkipNote(filename, verdict.reason, verdict.reason === 'too large' ? bytes.length : undefined));
      continue;
    }

    const id = crypto.randomUUID();
    const key = storageKeyFor(args.workspaceId, args.ticketId, id, filename);
    try {
      await store.putObject(key, bytes, {
        contentType: verdict.mime,
        contentDisposition: contentDispositionFor(verdict.disposition, filename),
      });
    } catch (err) {
      console.error(`[attachments] R2 upload failed for ${filename}:`, err instanceof Error ? err.message : err);
      result.skipped.push(formatSkipNote(filename, 'storage error'));
      continue;
    }

    const rawCid = (a.ContentID ?? '').trim().replace(/^<|>$/g, '');
    try {
      await sql`
        insert into ticket_attachments
          (id, workspace_id, ticket_id, message_id, filename, size_bytes, storage_key, mime_type, content_id, is_inline, disposition)
        values
          (${id}, ${args.workspaceId}, ${args.ticketId}, ${args.messageId}, ${filename}, ${verdict.size}, ${key},
           ${verdict.mime}, ${rawCid ? id : null}, false, ${verdict.disposition})
      `;
    } catch (err) {
      // Row failed after the object landed: remove the object so nothing is
      // orphaned (best-effort), then report.
      console.error(`[attachments] row insert failed for ${filename}:`, err instanceof Error ? err.message : err);
      await store.deleteKeys([key]).catch(() => {});
      result.skipped.push(formatSkipNote(filename, 'storage error'));
      continue;
    }
    if (rawCid) result.cidMap.set(rawCid, id);
    result.stored++;
  }
  return result;
}

/** Flag the attachments the sanitised HTML actually embeds as inline. */
export async function markInlineAttachments(sql: Sql | TransactionSql, workspaceId: string, ids: Iterable<string>): Promise<void> {
  const list = [...ids];
  if (list.length === 0) return;
  await sql`
    update ticket_attachments set is_inline = true
    where workspace_id = ${workspaceId} and id in ${sql(list)}
  `;
}

/**
 * All attachments of a ticket's messages, grouped by message id, each with a
 * presigned URL. Unclaimed uploads (message_id null) are excluded.
 */
export async function loadAttachmentsForTicket(
  workspaceId: string,
  ticketId: string,
  deps: StoreDeps = {},
): Promise<Map<string, PublicAttachment[]>> {
  const sql = getDb();
  const rows = await sql<AttachmentRow[]>`
    select id, message_id, filename, size_bytes, mime_type, is_inline, content_id, disposition, storage_key
    from ticket_attachments
    where workspace_id = ${workspaceId} and ticket_id = ${ticketId} and message_id is not null
    order by created_at asc
  `;
  const byMessage = new Map<string, PublicAttachment[]>();
  if (rows.length === 0) return byMessage;

  const configured = deps.configured ?? isAttachmentsStorageConfigured;
  const store = deps.store ?? (configured() ? attachmentsStore() : null);
  const urls = await Promise.all(
    rows.map(async (r) => {
      if (!store) return null;
      try {
        return await store.presignGet(r.storage_key);
      } catch (err) {
        console.warn(`[attachments] presign failed for ${r.id}:`, err instanceof Error ? err.message : err);
        return null;
      }
    }),
  );
  rows.forEach((r, i) => {
    const list = byMessage.get(r.message_id!) ?? [];
    list.push({
      id: r.id,
      filename: r.filename,
      size_bytes: r.size_bytes == null ? null : Number(r.size_bytes),
      mime_type: r.mime_type,
      is_inline: r.is_inline,
      disposition: r.disposition,
      url: urls[i],
    });
    byMessage.set(r.message_id!, list);
  });
  return byMessage;
}

/**
 * Attach `attachments` to each message row and swap cid: tokens in body_html
 * for the inline images' URLs. Pure — used by GET /tickets/:id and by the
 * reply route's response.
 */
export function decorateMessages<M extends { id: string; body_html?: string | null }>(
  messages: M[],
  byMessage: Map<string, PublicAttachment[]>,
): Array<M & { attachments: PublicAttachment[] }> {
  return messages.map((m) => {
    const attachments = byMessage.get(m.id) ?? [];
    const urlById = new Map<string, string>();
    for (const a of attachments) if (a.is_inline && a.url) urlById.set(a.id, a.url);
    const body_html = m.body_html ? rewriteCidsToUrls(m.body_html, urlById) : m.body_html ?? null;
    return { ...m, body_html, attachments };
  });
}
