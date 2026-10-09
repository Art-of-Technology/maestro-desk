import { chromium } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { HTTPException } from 'hono/http-exception';
import { sanitizeEmailHtml, rewriteCidsToUrls } from './email-html.js';
import { escapeHtml, MAX_HTML_CHARS } from './html-text.js';
import { sniffImageMime } from './image-sniff.js';
import { fetchEmailImage, MAX_EMAIL_IMAGE_BYTES } from './email-image.js';
import type { ExportEmail, ExportAttachment } from './email-export.js';

export interface EmailPdfOptions { remoteImages?: boolean; logoUrl?: string | null }
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 500;
const PAGE_WIDTH = 703; // A4 minus 12 mm margins, in CSS pixels.
type RenderDocument = {
  fonts: { ready: Promise<unknown> };
  getElementById(id: string): { textContent: string; hidden: boolean };
  documentElement: { scrollHeight: number; scrollWidth: number };
};
const font = readFileSync(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url)).toString('base64');

export function emailPdfHtml(email: ExportEmail, attachments: ExportAttachment[]): string {
  const urls = new Map(attachments.filter(a => a.is_inline).map(a => [a.id, `https://email-assets.invalid/${email.id}/${a.id}`]));
  const cidMap = new Map([...urls.keys()].map(id => [id, id]));
  const body = email.body_html
    ? rewriteCidsToUrls(sanitizeEmailHtml(email.body_html, { cidMap }).html, urls)
    : `<div style="white-space:pre-wrap">${escapeHtml(email.body || '')}</div>`;
  const metadata = email.email_metadata;
  const rawDate = metadata?.sent_at || metadata?.received_at || email.created_at;
  const date = new Date(rawDate);
  const displayDate = (Number.isFinite(date.getTime()) ? date : new Date(email.created_at)).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
  const header = [`<strong>${escapeHtml(email.subject || '(No subject)')}</strong>`,
    `From: ${escapeHtml(metadata?.from || `${email.author_label || 'Unknown'} (address not saved)`)}`,
    `To: ${escapeHtml(metadata?.to?.join(', ') || 'Not saved')}`,
    ...(metadata?.cc?.length ? [`Cc: ${escapeHtml(metadata.cc.join(', '))}`] : []), `Date: ${displayDate}`];
  const files = attachments.filter(a => !a.is_inline);
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src https: http:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
    <style>@font-face{font-family:ExportSans;src:url(data:font/ttf;base64,${font})}
    *{box-sizing:border-box;animation:none!important;transition:none!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    body{margin:0;font-family:Arial,ExportSans,sans-serif;font-size:14px;line-height:1.5;color:#202124;overflow-wrap:anywhere}
    img{max-width:100%;height:auto}table{max-width:100%}#export-header{font:12px/1.5 Arial,ExportSans,sans-serif;margin-bottom:20px;padding-bottom:12px;border-bottom:1px solid #ddd}
    #export-files,#export-notice{font:11px/1.5 Arial,ExportSans,sans-serif;margin-top:16px;padding-top:8px;border-top:1px solid #ddd}
    </style></head><body><div id="export-header">${header.join('<br>')}</div>
    <div id="export-body">${body}</div>${files.length ? `<div id="export-files"><strong>Attachments</strong><br>${files.map(a => escapeHtml(a.filename)).join('<br>')}</div>` : ''}
    <div id="export-notice" hidden></div></body></html>`;
}

export async function emailPdf(emails: ExportEmail[], attachments: ExportAttachment[], readFile: (key: string) => Promise<Uint8Array>, options: EmailPdfOptions): Promise<Uint8Array> {
  if (emails.some(m => (m.body_html?.length || 0) > MAX_HTML_CHARS)
    || emails.reduce((n, m) => n + (m.body_html?.length || m.body?.length || 0), 0) > 1_000_000) {
    throw new HTTPException(413, { message: 'This PDF would be too large. Download individual emails instead.' });
  }
  // Docker's namespace restrictions require Chromium's container mode. Only
  // sanitized static markup enters this credential-free, per-export process;
  // scripts and all direct network access are disabled below.
  const browser = await chromium.launch({ executablePath: process.env.PDF_CHROMIUM_PATH || undefined,
    headless: true, timeout: 15000,
    env: { PATH: process.env.PATH || '', HOME: tmpdir(), TMPDIR: tmpdir(),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } })
    .catch(() => { throw new HTTPException(503, { message: 'The PDF renderer is unavailable. Try again or download the emails as EML.' }); });
  const abort = new AbortController();
  const timer = setTimeout(() => { abort.abort(); void browser.close(); }, 60000);
  const merged = await PDFDocument.create();
  let imageBytes = 0, imageCount = 0, pdfBytes = 0;
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false,
      viewport: { width: PAGE_WIDTH, height: 1000 } });
    for (const email of emails) {
      abort.signal.throwIfAborted();
      const files = attachments.filter(a => a.message_id === email.id && a.ticket_id === email.ticket_id);
      let missing = 0, blocked = 0;
      let fatal: unknown;
      const page = await context.newPage();
      const imageCache = new Map<string, Promise<Uint8Array>>();
      await page.route('**/*', async route => {
        const request = route.request();
        const url = request.url();
        if (request.resourceType() !== 'image') { await route.abort(); return; }
        const attachment = files.find(a => a.is_inline && url === `https://email-assets.invalid/${email.id}/${a.id}`);
        const trustedLogo = url === options.logoUrl || url === email.sent_email?.logo_url;
        if (!attachment && !trustedLogo && !options.remoteImages) { blocked++; await route.abort(); return; }
        try {
          let image = imageCache.get(url);
          if (!image) {
            if (++imageCount > 100) throw new HTTPException(413, { message: 'This PDF has too many images. Download individual emails instead.' });
            image = (attachment ? readFile(attachment.storage_key) : fetchEmailImage(url, abort.signal)).then(async bytes => {
              imageBytes += bytes.byteLength;
              if (bytes.byteLength > MAX_EMAIL_IMAGE_BYTES || imageBytes > 32 * 1024 * 1024) throw new HTTPException(413, { message: 'The images in this PDF are too large. Download individual emails instead.' });
              if (!sniffImageMime(bytes)) throw new Error('Unsupported image format');
              // Decode one frame with a pixel limit before handing it to Chromium.
              const { default: sharp } = await import('sharp');
              const raster = await sharp(bytes, { limitInputPixels: 25_000_000, pages: 1, failOn: 'warning' })
                .png().timeout({ seconds: 3 }).toBuffer();
              imageBytes += Math.max(0, raster.byteLength - bytes.byteLength);
              if (raster.byteLength > MAX_EMAIL_IMAGE_BYTES || imageBytes > 32 * 1024 * 1024) throw new HTTPException(413, { message: 'The decoded images in this PDF are too large. Download individual emails instead.' });
              return raster;
            });
            imageCache.set(url, image);
          }
          const bytes = await image;
          await route.fulfill({ contentType: sniffImageMime(bytes)!, body: Buffer.from(bytes) });
        } catch (error) {
          if (attachment || error instanceof HTTPException) fatal = error;
          else missing++;
          await route.abort().catch(() => {});
        }
      });
      await page.emulateMedia({ media: 'screen' });
      await page.setContent(emailPdfHtml(email, files), { waitUntil: 'load', timeout: 15000 });
      if (fatal) throw fatal;
      // Our evaluation runs even though scripts inside the email are disabled.
      await page.evaluate(async ({ missing, blocked }) => {
        const doc = (globalThis as unknown as { document: RenderDocument }).document;
        await doc.fonts.ready;
        const notice = doc.getElementById('export-notice');
        notice.textContent = [blocked ? 'External images were not included.' : '', missing ? 'Some external images were unavailable.' : ''].filter(Boolean).join(' ');
        notice.hidden = !notice.textContent;
      }, { missing, blocked });
      const dimensions = await page.evaluate(() => {
        const element = (globalThis as unknown as { document: RenderDocument }).document.documentElement;
        return { height: element.scrollHeight, width: element.scrollWidth };
      });
      if (dimensions.height > MAX_PAGES * 1000 || dimensions.width > PAGE_WIDTH * 10) throw new HTTPException(413, { message: 'This PDF exceeds the page size limit. Download individual emails instead.' });
      const bytes = await page.pdf({ format: 'A4', printBackground: true, scale: Math.min(1, PAGE_WIDTH / dimensions.width),
        margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' } });
      pdfBytes += bytes.length;
      if (pdfBytes > MAX_BYTES) throw new HTTPException(413, { message: 'This PDF exceeds 50 MB. Download individual emails instead.' });
      const part = await PDFDocument.load(bytes);
      if (merged.getPageCount() + part.getPageCount() > MAX_PAGES) throw new HTTPException(413, { message: 'This PDF exceeds 500 pages. Download individual emails instead.' });
      for (const copied of await merged.copyPages(part, part.getPageIndices())) merged.addPage(copied);
      await page.close();
    }
    const bytes = await merged.save();
    if (bytes.length > MAX_BYTES) throw new HTTPException(413, { message: 'This PDF exceeds 50 MB. Download individual emails instead.' });
    return bytes;
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(503, { message: 'The formatted PDF could not be created. Try again or download the emails as EML.' });
  } finally { clearTimeout(timer); abort.abort(); await browser.close(); }
}
