// Best-effort HTML → plain text.
//
// Two callers, both "make this readable, never render it":
//   - inbound email (lib/postmark.ts pickBody): mail clients such as Gmail
//     mobile send an empty TextBody and an HTML body that is often just a
//     wrapper (`<div dir="auto"></div>`). Real Outlook mail carries a
//     <head><style> block whose CSS must not leak into the ticket body.
//   - outbound branding (lib/email-branding.ts): text fallback for the small
//     header/footer/signature HTML snippets an admin authored.
//
// Deliberately regex-based and never interprets the markup — the input is
// untrusted, and the output is always escaped again by whoever displays it.
// Returns '' for wrapper-only input so callers can apply their own placeholder.

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', euro: '€', pound: '£', middot: '·', bull: '•',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, ent: string) => {
    if (ent[0] === '#') {
      const hex = ent[1]?.toLowerCase() === 'x';
      const cp = hex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      // Reject anything fromCodePoint would throw on (or that is a lone
      // surrogate) — keep the literal text rather than crash the webhook.
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return match;
      return String.fromCodePoint(cp);
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? match;
  });
}

export function htmlToText(html: string): string {
  if (!html) return '';
  let s = html.replace(/\r\n?/g, '\n');

  // Non-content blocks go away WITH their contents.
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(head|style|script|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');

  // Block boundaries → line breaks. Gmail wraps each line in a <div>, so a
  // closing div is one newline; paragraph-level closers get a blank line.
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|h[1-6]|blockquote|pre|table|ul|ol)\s*>/gi, '\n\n');
  s = s.replace(/<\/(div|tr|li)\s*>/gi, '\n');
  s = s.replace(/<\/t[dh]\s*>/gi, ' ');

  // Everything else is markup we don't want.
  s = s.replace(/<[^>]+>/g, '');

  // Numeric &#160; and raw non-breaking spaces become ordinary spaces.
  s = decodeEntities(s).replace(/ /g, ' ');

  // Whitespace: tidy each line, cap blank-line runs at one.
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return s;
}
