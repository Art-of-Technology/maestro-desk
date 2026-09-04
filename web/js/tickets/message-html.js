// ─── Formatted (HTML) message bodies ─────────────────────────────────────────
// Renders an email's real formatting in the thread. The HTML has already been
// sanitised server-side (api/src/lib/email-html.ts), but it is still customer
// input, so it is displayed inside a locked-down <iframe srcdoc>:
//
//   • sandbox WITHOUT allow-scripts  → no JS can run, ever;
//   • its own <meta> CSP             → no scripts, no frames, no fonts, and by
//                                      default no REMOTE images (tracking
//                                      pixels) — only this message's own
//                                      attachments and data: URIs;
//   • <base target="_blank">         → links leave the app rather than
//                                      replacing the SPA inside the frame.
//
// allow-same-origin is required to measure the document's height from the
// parent; with scripts disabled inside the frame it grants nothing else.
//
// Remote images are opt-in per message ("Show remote images"), which is also
// the read-receipt/tracking-pixel guard: until an agent asks, a marketing mail
// cannot phone home.
//
// External reaches (interim, via window): escAttr, escHtml — still in app.js.

// Messages the agent has chosen to load remote images for, keyed
// `${ticketId}:${index}`. Module-scope so it survives the re-render that the
// toggle triggers, and resets on reload (a deliberate per-session choice).
const REMOTE_IMAGES_ON = new Set();

export function remoteImagesKey(ticketId, idx) { return `${ticketId}:${idx}`; }
export function remoteImagesEnabled(ticketId, idx) { return REMOTE_IMAGES_ON.has(remoteImagesKey(ticketId, idx)); }
export function enableRemoteImages(ticketId, idx) { REMOTE_IMAGES_ON.add(remoteImagesKey(ticketId, idx)); }

// Does this body pull anything from the network? (Attachment images are
// same-message and already allowed; these are the third-party ones.)
export function hasRemoteImages(html) {
  return /<img\b[^>]*\bsrc\s*=\s*["']https?:/i.test(html || '');
}

// The origins this message's own attachments live on (the presigned R2 host),
// so inline images load while everything else stays blocked.
function attachmentOrigins(attachments) {
  const origins = new Set();
  for (const a of attachments || []) {
    if (!a.url) continue;
    try { origins.add(new URL(a.url, window.location.href).origin); } catch { /* skip a malformed URL */ }
  }
  return [...origins];
}

// Minimal reset so a mail's own styles decide everything else. Height is
// measured from this document, so no margins of our own.
const FRAME_CSS = `
html,body{margin:0;padding:0;background:transparent}
body{font:14px/1.65 'Inter',system-ui,sans-serif;color:#130e30;word-break:break-word;overflow-x:auto}
img{max-width:100%;height:auto}
table{max-width:100%}
a{color:#130e30}
blockquote{margin:8px 0;padding-left:10px;border-left:2px solid rgba(19,14,48,.14);color:#413d54}
`;

/**
 * The srcdoc document for one message body.
 * @param {string} html sanitised message HTML
 * @param {string[]} imgOrigins origins allowed for <img>
 * @param {boolean} remote allow any https image
 */
function frameDocument(html, imgOrigins, remote) {
  const imgSrc = ['data:', ...(remote ? ['https:'] : imgOrigins)].join(' ') || "'none'";
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src ${imgSrc}; form-action 'none'; base-uri 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<base target="_blank"><style>${FRAME_CSS}</style></head><body>${html}</body></html>`;
}

/**
 * Body markup for a message. Falls back to the escaped plain text when the
 * message has no HTML (notes, older messages, plain-text mail).
 * @param {object} m mapped message ({ html, attachments, … })
 * @param {string} bodyText already-chosen text body (translation aware)
 * @param {string} ticketId
 * @param {number} idx message index within the thread
 * @param {string} fallbackHtml what to render when there is no `m.html`
 */
export function renderMessageBody(m, bodyText, ticketId, idx, fallbackHtml) {
  if (!m.html) return fallbackHtml;
  const remote = remoteImagesEnabled(ticketId, idx);
  const doc = frameDocument(m.html, attachmentOrigins(m.attachments), remote);
  const blocked = !remote && hasRemoteImages(m.html);
  const notice = blocked ? `
    <div class="msg-remote-note">
      <span>Remote images are blocked.</span>
      <button class="btn btn-sm" data-action="td.showRemoteImages" data-ticket-id="${window.escAttr(ticketId)}" data-msg-idx="${idx}">Show images</button>
    </div>` : '';
  return `${notice}<iframe class="msg-frame" data-msg-frame="1" title="Message content"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcdoc="${window.escAttr(doc)}"></iframe>`;
}

// Grow each frame to its content once it loads. Called after the thread is
// written to the DOM. Capped so a runaway newsletter scrolls inside its own
// frame instead of pushing the composer off-screen.
const MAX_FRAME_PX = 1200;
export function sizeMessageFrames(root) {
  const frames = (root || document).querySelectorAll ? (root || document).querySelectorAll('iframe[data-msg-frame]') : [];
  for (const frame of frames) {
    const fit = () => {
      try {
        const doc = frame.contentDocument;
        if (!doc || !doc.body) return;
        const h = Math.min(Math.max(doc.body.scrollHeight, 24), MAX_FRAME_PX);
        frame.style.height = `${h}px`;
      } catch { /* cross-origin or torn down mid-render — leave the default height */ }
    };
    frame.addEventListener('load', fit);
    fit();   // srcdoc frames can already be parsed by the time we get here
  }
}
