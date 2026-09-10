import sanitizeHtml from 'sanitize-html';
import { sanitizeEmailHtml } from './email-html.js';
import { htmlToText } from './html-text.js';

// Templates enter the editor DOM, unlike sandboxed received emails: no CSS.
export function templateBody(body: string, html?: string | null) {
  if (!html) return { body, body_html: null };
  const body_html = sanitizeHtml(sanitizeEmailHtml(html, { allowDataImages: true }).html, {
    allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'ol', 'ul', 'li', 'a', 'img', 'blockquote', 'pre', 'code'],
    allowedAttributes: { a: ['href', 'target', 'rel'], img: ['src', 'alt'] },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['https', 'http', 'data'] },
    allowProtocolRelative: false,
  });
  return { body: htmlToText(body_html) || (/<img\b/i.test(body_html) ? '[Image]' : ''), body_html: body_html || null };
}
