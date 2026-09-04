// Email HTML sanitiser (write-time) + cid: → URL rewriting (read-time).
//
// Layer 1 of 3 for rendering untrusted email HTML in the agent UI:
//   1. this module strips everything but presentational markup BEFORE the HTML
//      is stored on ticket_messages.body_html (the raw original stays on
//      inbox_messages.body_html for a future re-sanitise);
//   2. the SPA renders body_html inside a script-less sandboxed <iframe srcdoc>;
//   3. that frame carries its own meta-CSP (no remote images unless the agent
//      asks, no scripts, no frames, no forms).
// Agent-authored rich replies go through the same function — agents can be
// phished too, and their HTML is shown to colleagues.
//
// Inline images: an email references its own attachments as
// `<img src="cid:<Content-ID>">`. On ingest the Content-ID is mapped to OUR
// attachment uuid (`cidMap`) and the src is normalised to `cid:<uuid>`, so the
// stored HTML contains only a safe-charset token. At read time
// rewriteCidsToUrls() swaps those tokens for freshly presigned URLs — URLs
// expire, tokens don't. Unknown cids lose their src (a broken image, never a
// dangling reference to something we don't hold).

import sanitizeHtml from 'sanitize-html';

// Same cap as lib/html-text.ts: no legitimate ticket body is anywhere near this.
const MAX_HTML_CHARS = 1_000_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Only raster formats a browser renders safely; never svg+xml (scriptable).
const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

// Tags that carry layout/formatting in real-world email HTML (Outlook/Gmail/
// Apple Mail tables + legacy <font>/<center>) on top of sanitize-html's safe
// default set. Deliberately NOT here: style/script/iframe/object/embed/form/
// input/button/link/meta/base/svg/math/video/audio/template/noscript.
const ALLOWED_TAGS = [
  ...sanitizeHtml.defaults.allowedTags,
  'img', 'font', 'center', 'strike', 'tt', 'big', 'ins', 'del', 'u', 's', 'hr', 'br',
];

// Attributes whose values are never URLs (the URL-bearing ones are listed per
// tag and scheme-checked). `style` is passed through unfiltered on purpose:
// email layout is 90 % inline CSS and everything renders inside the sandbox.
const GLOBAL_ATTRS = [
  'style', 'align', 'valign', 'width', 'height', 'dir', 'lang', 'title',
  'bgcolor', 'color', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'nowrap',
];

// Disallowed tags whose CONTENT must vanish with them (not just the tag).
// Default is script/style/textarea/option/xmp; email adds <title> and the
// whole <head>, plus anything that could carry executable/foreign markup.
const NON_TEXT_TAGS = [
  'script', 'style', 'textarea', 'option', 'xmp', 'title', 'head', 'noscript', 'template',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'svg', 'math', 'select', 'button',
];

export interface SanitizeOptions {
  // Raw Content-ID (as it appears after `cid:` in the HTML, angle brackets
  // stripped) → our attachment uuid.
  cidMap?: Map<string, string>;
  // Allow `data:image/*;base64` <img> sources. True for agent-authored HTML on
  // the way IN (the editor pastes images that way; the caller then extracts
  // them into real attachments). Never for stored inbound mail.
  allowDataImages?: boolean;
}

export interface SanitizedHtml {
  html: string;
  // Attachment uuids referenced by <img src="cid:…"> in the output — these are
  // the truly inline ones (an unreferenced Content-ID file is a plain attachment).
  usedCids: Set<string>;
}

function normaliseCid(raw: string): string {
  return raw.trim().replace(/^cid:/i, '').replace(/^<|>$/g, '').trim();
}

/** Sanitise untrusted email HTML for storage. Empty/wrapper-only input → ''. */
export function sanitizeEmailHtml(html: string, opts: SanitizeOptions = {}): SanitizedHtml {
  const usedCids = new Set<string>();
  const input = (html ?? '').slice(0, MAX_HTML_CHARS);
  if (!input.trim()) return { html: '', usedCids };

  const out = sanitizeHtml(input, {
    allowedTags: ALLOWED_TAGS,
    nonTextTags: NON_TEXT_TAGS,
    allowedAttributes: {
      '*': GLOBAL_ATTRS,
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height', 'style', 'align', 'border', 'title'],
      font: ['face', 'size', 'color', 'style'],
      td: [...GLOBAL_ATTRS, 'headers', 'scope'],
      th: [...GLOBAL_ATTRS, 'headers', 'scope'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'cid', ...(opts.allowDataImages ? ['data'] : [])] },
    allowProtocolRelative: false,
    // Ignore anything after </html> (some clients append junk / tracking).
    enforceHtmlBoundary: true,
    disallowedTagsMode: 'discard',
    transformTags: {
      // Every link opens in a new tab and never gets a referrer / opener.
      a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
      img: (tagName, attribs) => {
        const src = (attribs.src ?? '').trim();
        const next = { ...attribs };
        if (/^cid:/i.test(src)) {
          const id = opts.cidMap?.get(normaliseCid(src));
          if (id && UUID_RE.test(id)) {
            next.src = `cid:${id.toLowerCase()}`;
            usedCids.add(id.toLowerCase());
          } else {
            delete next.src;
          }
        } else if (/^data:/i.test(src)) {
          if (!(opts.allowDataImages && DATA_IMAGE_RE.test(src))) delete next.src;
        }
        // Lazy-loading hints and srcset are dropped by the attribute allow-list.
        return { tagName, attribs: next };
      },
    },
    // Drop images that ended up with no usable source at all.
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
  });

  // A body that is only wrapper markup (Gmail's `<div dir="auto"></div>`)
  // should read as empty so the UI falls back to the text body.
  const visible = out.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  if (!visible && !/<img\b/i.test(out) && !/<hr\b/i.test(out)) return { html: '', usedCids };
  return { html: out, usedCids };
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Read-time: replace `src="cid:<uuid>"` tokens with the presigned URL for that
 * attachment. Tokens with no URL (attachment gone, storage unconfigured) are
 * left as-is — the browser shows a broken image rather than us guessing.
 * Strict on shape: only sanitised output (double-quoted attrs, uuid tokens)
 * ever reaches this, so a stray `cid:` in text is never touched.
 */
export function rewriteCidsToUrls(html: string, urlByAttachmentId: Map<string, string>): string {
  if (!html || urlByAttachmentId.size === 0) return html;
  return html.replace(
    /src="cid:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi,
    (m, id: string) => {
      const url = urlByAttachmentId.get(id.toLowerCase());
      return url ? `src="${escapeAttr(url)}"` : m;
    },
  );
}
