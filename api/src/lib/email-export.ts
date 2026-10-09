import { emailPdf, type EmailPdfOptions } from './email-pdf.js';
import type { SentEmail } from './sent-email.js';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { zipSync } from 'fflate';

import { HTTPException } from 'hono/http-exception';
import { sanitizeEmailHtml } from './email-html.js';
import { htmlToText } from './html-text.js';
import type { AttachmentRow } from './message-attachments.js';

export interface ExportEmail {
  id: string;
  ticket_id: string;
  role: string;
  author_label: string;
  body: string;
  body_html: string | null;
  external_message_id: string | null;
  email_metadata: { status?: string; from?: string; to?: string[]; cc?: string[]; reply_to?: string; sent_at?: string; received_at?: string } | null;
  created_at: Date | string;
  subject: string;
  merged_from_id: string | null;
  sent_email?: SentEmail | null;
  forwarded_from_ticket_ids?: string[];
}

export function isExportableEmail(m: Pick<ExportEmail, 'role' | 'email_metadata' | 'external_message_id'>): boolean {
  if (!['customer', 'agent', 'ai'].includes(m.role)) return false;
  const status = m.email_metadata?.status;
  if (status) return m.role === 'customer' ? status === 'received' : status === 'sent';
  // Older delivered replies (including automatic replies) predate metadata.
  return Boolean(m.external_message_id);
}

export const MAX_EXPORT_BYTES = 50 * 1024 * 1024;
export const MAX_EXPORT_MESSAGES = 500;
export function checkExportSize(bytes: number): void {
  if (bytes > MAX_EXPORT_BYTES) throw new HTTPException(413, { message: 'This download is too large. Download individual emails instead (50 MB maximum).' });
}

function emailDate(m: ExportEmail): Date {
  const saved = m.email_metadata?.sent_at || m.email_metadata?.received_at;
  const date = new Date(saved || m.created_at);
  return Number.isFinite(date.getTime()) ? date : new Date(m.created_at);
}

export function chronologicalEmails(messages: ExportEmail[]): ExportEmail[] {
  return messages.filter(isExportableEmail).sort((a, b) => emailDate(a).getTime() - emailDate(b).getTime() || a.id.localeCompare(b.id));
}

export type ExportAttachment = AttachmentRow & { ticket_id: string };
export async function buildEmailDownload(
  emails: ExportEmail[], attachments: ExportAttachment[], format: 'pdf' | 'eml', single: boolean,
  readFile: (key: string) => Promise<Uint8Array>,
  pdfOptions: EmailPdfOptions = {},
): Promise<Uint8Array> {
  if (emails.length > MAX_EXPORT_MESSAGES) throw new HTTPException(413, { message: 'This thread has more than 500 emails. Download individual emails instead.' });
  emails = emails.map(m => m.sent_email ? { ...m, subject: m.sent_email.subject, body: m.sent_email.text, body_html: m.sent_email.html } : m);
  let size = emails.reduce((n, m) => n + Buffer.byteLength(m.body || '') + Buffer.byteLength(m.body_html || ''), 0);
  checkExportSize(size);
  // Never trust unrelated/draft attachment rows supplied by a caller.
  const files = attachments.filter(a => emails.some(m => m.id === a.message_id && m.ticket_id === a.ticket_id));
  if (format === 'pdf') return emailPdf(emails, files, readFile, pdfOptions);
  checkExportSize(size + files.reduce((n, a) => n + (a.size_bytes || 0), 0));
  const entries: Record<string, Uint8Array> = {};
  for (const [index, m] of emails.entries()) {
    const messageFiles = [];
    for (const a of files.filter(a => a.message_id === m.id)) {
      const bytes = await readFile(a.storage_key);
      size += bytes.byteLength;
      checkExportSize(size);
      messageFiles.push({ filename: a.filename, content: Buffer.from(bytes), contentType: a.mime_type || 'application/octet-stream',
        contentDisposition: a.is_inline ? 'inline' as const : 'attachment' as const,
        // Stored HTML refers to attachment UUIDs, not the original Content-ID.
        cid: a.is_inline ? a.id : undefined });
    }
    const metadata = m.email_metadata;
    const cidMap = new Map(messageFiles.filter(a => a.cid).map(a => [a.cid!, a.cid!]));
    const content = await new MailComposer({
      from: metadata?.from || undefined, to: metadata?.to, cc: metadata?.cc,
      replyTo: metadata?.reply_to || undefined,
      date: emailDate(m), subject: m.subject,
      messageId: m.external_message_id || undefined,
      text: m.body || htmlToText(m.body_html || ''),
      html: m.body_html ? sanitizeEmailHtml(m.body_html, { cidMap }).html : undefined,
      attachments: messageFiles,
      headers: { 'X-Respovia-Export': 'Reconstructed from saved ticket content; original transport headers unavailable',
        'X-Respovia-Saved-Author': m.author_label || 'Unknown' },
      disableFileAccess: true, disableUrlAccess: true,
    }).compile().build();
    if (single) { checkExportSize(content.length); return content; }
    entries[`${String(index + 1).padStart(3, '0')}-${m.id}.eml`] = content;
  }
  // MIME content is already base64 encoded. Storing avoids expensive synchronous
  // compression; input and concurrent requests are bounded by the route.
  checkExportSize(Object.values(entries).reduce((n, b) => n + b.byteLength, 0));
  const bytes = zipSync(entries, { level: 0 });
  checkExportSize(bytes.byteLength);
  return bytes;
}
