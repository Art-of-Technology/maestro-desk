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

let emailLogo = null;

// Only workspace settings establish trust, never an email's alt text or host.
export function setEmailLogo(url) {
  emailLogo = typeof url === 'string' && /^https:\/\//i.test(url)
    ? { url, image: null } : null;
}

function embeddedLogo(logo) {
  return logo.image ||= new Promise(resolve => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.referrerPolicy = 'no-referrer';
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        // Bound rasterisation memory without enlarging the logo's intrinsic size.
        const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      } catch { resolve(null); } // CORS/canvas failures keep the manual image control.
    };
    image.onerror = () => resolve(null);
    image.src = logo.url;
  });
}

async function showEmailLogo(frame, doc) {
  const logo = emailLogo;
  const images = [...doc.images].filter(img => img.getAttribute('src') === logo?.url);
  if (!images.length) return;
  const source = await embeddedLogo(logo);
  if (!source || emailLogo !== logo || !frame.isConnected || frame.contentDocument !== doc) return;
  for (const img of images) {
    if (img.getAttribute('src') === logo.url) img.src = source;
  }
  // Leave the CSP unchanged: only the exact logo becomes an embedded image.
  if (!hasRemoteImages(doc.body.innerHTML)) {
    const notice = frame.previousElementSibling;
    if (notice?.classList.contains('msg-remote-note')) notice.remove();
  }
}

export function remoteImagesKey(ticketId, idx) { return `${ticketId}:${idx}`; }
export function remoteImagesEnabled(ticketId, idx) { return REMOTE_IMAGES_ON.has(remoteImagesKey(ticketId, idx)); }
export function enableRemoteImages(ticketId, idx) { REMOTE_IMAGES_ON.add(remoteImagesKey(ticketId, idx)); }

// Does this body pull anything from the network? Covers <img src> AND CSS
// `url(...)` in style attributes (background images are the other common
// tracking-pixel carrier), so the "images blocked" notice matches what the
// frame CSP actually blocks. Attachment images are same-message and allowed.
export function hasRemoteImages(html) {
  const s = html || '';
  return /<img\b[^>]*\bsrc\s*=\s*["']https?:/i.test(s) || /url\(\s*["']?https?:/i.test(s);
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
html{overflow-y:auto}
body{font:14px/1.65 'Inter',system-ui,sans-serif;color:#201238;word-break:break-word;overflow-x:auto;display:flow-root}
img{max-width:100%;height:auto}
table{max-width:100%}
a{color:#6d28d9}
blockquote{margin:8px 0;padding-left:10px;border-left:2px solid rgba(19,14,48,.14);color:#493b60}
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

export function renderEmailPreview(html, attachments) {
  return `<iframe title="Original email" sandbox="allow-same-origin" style="width:100%;height:300px;border:1px solid var(--rule)"
    srcdoc="${window.escAttr(frameDocument(html, attachmentOrigins(attachments), false))}"></iframe>`;
}

/**
 * Body markup for a message. Falls back to the escaped plain text when the
 * message has no HTML (notes, older messages, plain-text mail).
 * @param {object} m mapped message ({ html, attachments, … })
 * @param {string} ticketId
 * @param {number} idx message index within the thread
 * @param {string} fallbackHtml what to render when there is no `m.html`
 */
export function renderMessageBody(m, ticketId, idx, fallbackHtml) {
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

let disposeSizing = () => {};
const pendingScroll = new WeakMap();

export function captureMessageScroll(root) {
  if (!root?.children?.length) return null;
  // Draft/detail refreshes can replace the thread before its frames finish loading.
  if (pendingScroll.has(root)) return pendingScroll.get(root);
  if (root.scrollHeight - root.clientHeight - root.scrollTop < 40) return 'bottom';
  const top = root.getBoundingClientRect().top;
  const index = [...root.children].findIndex(el => el.getBoundingClientRect().bottom > top);
  return index < 0 ? null : { index, offset: root.children[index].getBoundingClientRect().top - top };
}

export function restoreMessageScroll(root, position = null) {
  if (position === 'bottom') { root.scrollTop = root.scrollHeight; return; }
  const message = position === null ? root.lastElementChild : root.children[position.index];
  if (message) root.scrollTop += message.getBoundingClientRect().top - root.getBoundingClientRect().top - (position?.offset || 0);
}

// The thread owns vertical scrolling. Size frames to their intrinsic content,
// including late images and width changes, rather than capping long emails.
export function sizeMessageFrames(root, initialPosition = null) {
  disposeSizing();
  if (!root?.querySelectorAll || !root.isConnected) return;
  const frames = [...root.querySelectorAll('iframe[data-msg-frame]')];
  if (!frames.length) return;
  pendingScroll.set(root, initialPosition);
  const observers = new Map();
  const loaded = new Set();
  const settled = new Set();
  let restoreInitial = true;
  let disposed = false;
  let scheduled = 0;

  const userReading = () => { restoreInitial = false; pendingScroll.delete(root); };
  const fit = () => {
    scheduled = 0;
    if (disposed || !root.isConnected) return;
    const pinned = root.scrollHeight - root.clientHeight - root.scrollTop < 40;
    const top = root.getBoundingClientRect().top;
    const anchor = [...root.children].find(el => el.getBoundingClientRect().bottom > top);
    const anchorTop = anchor?.getBoundingClientRect().top;
    let changed = false;
    for (const frame of frames) {
      try {
        const body = frame.contentDocument?.body;
        if (!body || !loaded.has(frame)) continue;
        // flow-root contains paragraph margins and floated images. Unlike the
        // documentElement, this height is not floored by the iframe viewport,
        // so a frame can shrink again when the reading column gets wider.
        const height = Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().height, 24));
        const next = `${height}px`;
        if (frame.style.height !== next) { frame.style.height = next; changed = true; }
      } catch { /* a followed link can make a frame cross-origin */ }
    }
    if (restoreInitial) {
      restoreMessageScroll(root, initialPosition);
      if (settled.size === frames.length) userReading();
    } else if (changed) {
      if (pinned) root.scrollTop = root.scrollHeight;
      else if (anchor?.isConnected) root.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    }
  };
  const schedule = () => {
    if (!disposed && !scheduled) scheduled = requestAnimationFrame(fit);
  };
  const watch = frame => {
    observers.get(frame)?.disconnect();
    try {
      const doc = frame.contentDocument;
      if (!doc?.body || doc.URL !== 'about:srcdoc') return;
      void showEmailLogo(frame, doc);
      loaded.add(frame);
      if (doc.readyState === 'complete') settled.add(frame);
      // Some emails bring their own fixed-height scrolling divs. Expand only
      // explicit scrolling containers; leave intentionally hidden content alone.
      for (const el of doc.body.querySelectorAll('[style]')) {
        const computed = doc.defaultView.getComputedStyle(el);
        // Viewport-height units otherwise create feedback: growing the frame
        // grows its content again. Freeze resolved lengths before observing.
        // Only layout properties are considered, never URLs or CSS strings.
        for (const property of [...el.style]) {
          if (!/^(height|min-height|max-height|width|min-width|max-width|font-size|line-height|padding.*|margin.*|top|bottom|left|right|inset.*|gap|row-gap|column-gap|transform)$/.test(property)) continue;
          if (!/\d(?:s|l|d)?v(?:h|b|min|max)\b/i.test(el.style.getPropertyValue(property))) continue;
          el.style.setProperty(property, computed.getPropertyValue(property), 'important');
        }
        if (!/\b(auto|scroll)\b/.test(el.style.overflowY || el.style.overflow)) continue;
        const overflow = computed.overflowY;
        if (overflow !== 'auto' && overflow !== 'scroll') continue;
        el.style.setProperty('height', 'auto', 'important');
        el.style.setProperty('max-height', 'none', 'important');
        el.style.setProperty('overflow', 'visible', 'important');
      }
      const observer = new ResizeObserver(schedule);
      observer.observe(doc.body);
      observers.set(frame, observer);
      // Wheel events inside srcdoc do not bubble into the parent document.
      doc.addEventListener('wheel', userReading, { passive: true });
      doc.addEventListener('touchstart', userReading, { passive: true });
      doc.addEventListener('keydown', userReading);
      doc.addEventListener('load', schedule, true);
      schedule();
    } catch { /* cross-origin or removed during navigation */ }
  };
  const loads = frames.map(frame => {
    const onLoad = () => watch(frame);
    frame.addEventListener('load', onLoad);
    watch(frame);
    return () => frame.removeEventListener('load', onLoad);
  });
  root.addEventListener('wheel', userReading, { passive: true });
  root.addEventListener('touchstart', userReading, { passive: true });
  root.addEventListener('pointerdown', userReading);
  root.addEventListener('keydown', userReading);
  // Navigation replaces the entire ticket subtree. Disconnect promptly so
  // observers never retain detached emails or continue resizing old frames.
  const removal = new MutationObserver(() => { if (!root.isConnected) cleanup(); });
  const cleanup = () => {
    disposed = true;
    pendingScroll.delete(root);
    cancelAnimationFrame(scheduled);
    removal.disconnect();
    observers.forEach(observer => observer.disconnect());
    loads.forEach(remove => remove());
    root.removeEventListener('wheel', userReading);
    root.removeEventListener('touchstart', userReading);
    root.removeEventListener('pointerdown', userReading);
    root.removeEventListener('keydown', userReading);
    for (const frame of frames) {
      try {
        const doc = frame.contentDocument;
        doc?.removeEventListener('wheel', userReading);
        doc?.removeEventListener('touchstart', userReading);
        doc?.removeEventListener('keydown', userReading);
        doc?.removeEventListener('load', schedule, true);
      } catch { /* navigated frame */ }
    }
    if (disposeSizing === cleanup) disposeSizing = () => {};
  };
  removal.observe(root.closest('#main-area') || document.body, { childList: true, subtree: true });
  disposeSizing = cleanup;
}
