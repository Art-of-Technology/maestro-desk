import PDFDocument from 'pdfkit';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { zipSync } from 'fflate';
import { fileURLToPath } from 'node:url';
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
): Promise<Uint8Array> {
  if (emails.length > MAX_EXPORT_MESSAGES) throw new HTTPException(413, { message: 'This thread has more than 500 emails. Download individual emails instead.' });
  let size = emails.reduce((n, m) => n + Buffer.byteLength(m.body || '') + Buffer.byteLength(m.body_html || ''), 0);
  checkExportSize(size);
  // Never trust unrelated/draft attachment rows supplied by a caller.
  const files = attachments.filter(a => emails.some(m => m.id === a.message_id && m.ticket_id === a.ticket_id));
  if (format === 'pdf') return emailPdf(emails, files);
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

const fontPath = fileURLToPath(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url));
async function emailPdf(emails: ExportEmail[], files: ExportAttachment[]): Promise<Uint8Array> {
  if (emails.reduce((n, m) => n + (m.body?.length || m.body_html?.length || 0), 0) > 1_000_000) {
    throw new HTTPException(413, { message: 'This PDF would be too large. Choose Email (.eml) or download individual emails.' });
  }
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: 'Ticket emails', Author: 'Respovia' } });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let pages = 1;
  doc.on('pageAdded', () => {
    if (++pages > 500) throw new HTTPException(413, { message: 'This PDF exceeds 500 pages. Choose Email (.eml) or download individual emails.' });
  });
  const completed = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_EXPORT_BYTES) doc.destroy(new Error('PDF too large')); else chunks.push(chunk); });
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  // Attach the rejection handler before rendering can fail synchronously.
  void completed.catch(() => {});
  try {
    doc.font(fontPath);
    function text(value: string, size = 10) {
      value = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
      // PDFKit otherwise silently writes missing glyphs. Offer the lossless
      // email format when this bundled font cannot represent a script/emoji.
      const font = (doc as unknown as { _font: { font: { hasGlyphForCodePoint: (cp: number) => boolean } } })._font.font;
      if ([...value].some(char => !/\s/.test(char) && !font.hasGlyphForCodePoint(char.codePointAt(0)!))) {
        throw new HTTPException(422, { message: 'Some characters cannot be displayed in PDF. Choose Email (.eml) to keep the full content.' });
      }
      doc.fontSize(size).text(value, { lineGap: 3 });
    }
    text(emails.length === 1 ? 'Ticket email' : 'Ticket email thread', 20);
    doc.moveDown(0.5);
    text('Saved email content. Original transport headers are not retained. Attachments are listed below; choose Email (.eml) to download the files.', 9);
    for (const [i, m] of emails.entries()) {
      if (i) doc.addPage(); else doc.moveDown(1.5);
      text(m.subject || '(No subject)', 15);
      doc.moveDown(0.5);
      text(`From: ${m.email_metadata?.from || `${m.author_label || 'Unknown'} (address not saved)`}`);
      text(`To: ${m.email_metadata?.to?.join(', ') || 'Not saved'}`);
      if (m.email_metadata?.cc?.length) text(`Cc: ${m.email_metadata.cc.join(', ')}`);
      text(`Date: ${emailDate(m).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}`);
      doc.moveDown();
      text(m.body || htmlToText(m.body_html || '') || '(No text content saved)');
      const attached = files.filter(a => a.message_id === m.id);
      if (attached.length) { doc.moveDown(); text('Attachments', 11); for (const a of attached) text(a.filename); }
    }
    doc.end();
    return await completed;
  } catch (error) { doc.destroy(); throw error; }
}
