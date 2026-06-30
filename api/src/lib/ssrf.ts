import dns from 'node:dns/promises';
import net from 'node:net';

// SSRF guard for server-side fetches of user-supplied URLs (outgoing webhooks).
//
// The platform delivers signed event payloads (which carry customer PII) to
// workspace-configured URLs. Without this guard a URL could be aimed at the
// cloud metadata endpoint (169.254.169.254), loopback, or an RFC1918 host and
// turn the API's egress into an SSRF oracle. We:
//   1. allow only http/https schemes (blocks file:, gopher:, data:, …), and
//   2. resolve the host and reject if ANY resolved address is in a private,
//      loopback, link-local/metadata, or otherwise non-public range.
//
// Throws on rejection so callers can surface a 400 (write time) or record a
// permanent delivery failure (delivery time).
//
// NOTE: this is a check-then-connect guard. A determined attacker controlling
// DNS could rebind between this lookup and fetch's own resolve (TOCTOU). That
// residual is mitigated by the caller using redirect:'manual', but fully
// closing it requires pinning the resolved IP via a custom dispatcher.
// TODO: pin IP to fully defeat DNS rebinding if this surface ever widens.

function isBlockedIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed → block
  const [a, b] = p;
  if (a === 0) return true;                              // 0.0.0.0/8 "this host"
  if (a === 10) return true;                             // 10.0.0.0/8 private
  if (a === 127) return true;                            // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;               // 169.254.0.0/16 link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true;               // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true;     // 100.64.0.0/10 CGNAT
  if (a >= 224) return true;                             // 224.0.0.0/4 multicast + 240/4 reserved
  return false;
}

// Parse a (net.isIP-validated) IPv6 string into its 16 bytes. Handles `::`
// compression and an embedded dotted-IPv4 tail (e.g. ::ffff:127.0.0.1).
// Returns null if it can't parse — callers treat null as "block" (fail safe).
// String matching on IPv6 text is bypass-prone (hex vs dotted v4-mapped,
// partial prefix matches); normalising to bytes and checking prefixes is the
// only reliable way.
function ipv6ToBytes(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]; // drop any zone id
  let v4tail: number[] | null = null;
  if (s.includes('.')) {
    // Embedded IPv4 in the final group: take everything after the last colon.
    const i = s.lastIndexOf(':');
    if (i < 0) return null;
    const parts = s.slice(i + 1).split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    v4tail = parts;
    s = s.slice(0, i + 1); // keep the trailing ':'
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter((g) => g !== '') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter((g) => g !== '') : [];
  const v4groups = v4tail ? 2 : 0;
  const explicit = head.length + tail.length + v4groups;
  const groups: number[] = [];
  for (const g of head) groups.push(parseInt(g, 16));
  if (halves.length === 2) {
    const fill = 8 - explicit;
    if (fill < 0) return null;
    for (let k = 0; k < fill; k++) groups.push(0);
  } else if (explicit !== 8) {
    return null; // no `::` → must be exactly 8 groups
  }
  for (const g of tail) groups.push(parseInt(g, 16));
  const bytes: number[] = [];
  for (const n of groups) {
    if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  if (v4tail) bytes.push(...v4tail);
  return bytes.length === 16 ? bytes : null;
}

function isBlockedIPv6(ip: string): boolean {
  const b = ipv6ToBytes(ip);
  if (!b) return true; // unparseable → block
  const zeroUpTo = (n: number) => b.slice(0, n).every((x) => x === 0);
  // :: (unspecified) and ::1 (loopback)
  if (zeroUpTo(15) && (b[15] === 0 || b[15] === 1)) return true;
  // IPv4-mapped ::ffff:a.b.c.d (/96) and IPv4-compatible ::a.b.c.d (/96, deprecated)
  if (zeroUpTo(10) && ((b[10] === 0xff && b[11] === 0xff) || zeroUpTo(12))) {
    return isBlockedIPv4(b.slice(12).join('.'));
  }
  // 6to4 2002::/16 — embeds the v4 in bytes 2..5
  if (b[0] === 0x20 && b[1] === 0x02) return isBlockedIPv4(b.slice(2, 6).join('.'));
  // NAT64 well-known prefix 64:ff9b::/96 — embeds the v4 in the low 32 bits
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return isBlockedIPv4(b.slice(12).join('.'));
  if ((b[0] & 0xfe) === 0xfc) return true;               // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xff) return true;                        // ff00::/8 multicast
  return false;
}

function isBlockedAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedIPv4(ip);
  if (kind === 6) return isBlockedIPv6(ip);
  return true; // not a recognisable IP → block
}

// Validates that `raw` is an http(s) URL whose host resolves only to public
// addresses. Throws an Error (message safe to log / return) otherwise.
export async function assertSafeWebhookUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Disallowed URL scheme: ${url.protocol}`);
  }

  // url.hostname keeps the brackets for an IPv6 literal ([::1]); strip them so
  // net.isIP recognises it and we take the deterministic literal-IP branch
  // instead of falling through to a (resolver-dependent) dns.lookup.
  const host = url.hostname.replace(/^\[(.+)\]$/, '$1');
  // A literal IP host is checked directly; a name is resolved (all records).
  if (net.isIP(host) !== 0) {
    if (isBlockedAddress(host)) throw new Error('URL host is a private or internal address');
    return;
  }

  let records: { address: string }[];
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    throw new Error('URL host does not resolve');
  }
  if (records.length === 0) throw new Error('URL host does not resolve');
  for (const { address } of records) {
    if (isBlockedAddress(address)) {
      throw new Error('URL resolves to a private or internal address');
    }
  }
}
