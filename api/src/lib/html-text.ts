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
// Every tag pattern uses `[^<>]` (never `[^>]`) so a body full of unmatched
// `<` stays linear — this runs synchronously inside the Postmark webhook.
// Returns '' for wrapper-only input so callers can apply their own placeholder.

// HTML 4 Latin-1 names, in code-point order from U+00A0 to U+00FF.
const LATIN1_NAMES =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr ' +
  'deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest ' +
  'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ' +
  'ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig ' +
  'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml ' +
  'eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', euro: '€', bull: '•',
};
LATIN1_NAMES.split(' ').forEach((name, i) => { NAMED_ENTITIES[name] = String.fromCodePoint(0xa0 + i); });

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, ent: string) => {
    if (ent[0] === '#') {
      const hex = ent[1]?.toLowerCase() === 'x';
      const cp = hex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      // Reject anything fromCodePoint would throw on (or that is a lone
      // surrogate) — keep the literal text rather than crash the webhook.
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return match;
      return String.fromCodePoint(cp);
    }
    // Entity names are case-sensitive (&Eacute; ≠ &eacute;); fall back to the
    // lower-case form for sloppy upper-cased ampersand entities like &AMP;.
    return NAMED_ENTITIES[ent] ?? NAMED_ENTITIES[ent.toLowerCase()] ?? match;
  });
}

const BLOCK_OPENERS = 'div|p|h[1-6]|blockquote|pre|table|ul|ol|tr|li';

export function htmlToText(html: string): string {
  if (!html) return '';
  let s = html.replace(/\r\n?/g, '\n');

  // Plain text (no tags) keeps the author's own line breaks; only markup
  // goes through the structural pass below.
  if (/<[a-z!/]/i.test(s)) {
    // Non-content blocks go away WITH their contents. An unclosed block (broken
    // or truncated mail) is dropped to the end rather than leaking CSS/JS text.
    s = s.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
    s = s.replace(/<(head|style|script|title)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');

    // Source formatting (Outlook/Word wrap at ~72 cols) is not content —
    // line breaks come from <br> and block tags only.
    s = s.replace(/\s+/g, ' ');

    // Links: keep the destination, which the tag strip would otherwise lose.
    // `label (https://…)` unless the label already IS the URL.
    s = s.replace(
      /<a\b[^<>]*?\bhref\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')[^<>]*>([^<]*(?:<(?!\/a\s*>)[^<>]*>[^<]*)*)<\/a\s*>/gi,
      (whole, dq: string | undefined, sq: string | undefined, inner: string) => {
        const href = (dq ?? sq ?? '').trim();
        if (!/^https?:\/\//i.test(href)) return whole;
        const label = inner.replace(/<[^<>]+>/g, '').trim();
        if (!label) return href;
        const same = (a: string) => a.replace(/\/+$/, '').toLowerCase();
        return same(label) === same(href) ? inner : `${inner} (${href})`;
      },
    );

    // Block boundaries → line breaks. Text directly followed by an opening
    // block (Gmail web: `<div>First<div>Second</div></div>`) breaks before it;
    // Gmail wraps each line in a <div>, so a closing div is one newline and
    // paragraph-level closers get a blank line.
    s = s.replace(new RegExp(`([^\\s>])[ \\t]*<(${BLOCK_OPENERS})\\b`, 'gi'), '$1\n<$2');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/(p|h[1-6]|blockquote|pre|table|ul|ol)\s*>/gi, '\n\n');
    s = s.replace(/<\/(div|tr|li)\s*>/gi, '\n');
    s = s.replace(/<\/t[dh]\s*>/gi, ' ');

    // Everything else is markup we don't want.
    s = s.replace(/<[^<>]+>/g, '');
  }

  // Numeric &#160;, &nbsp; and raw non-breaking spaces become ordinary spaces.
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
