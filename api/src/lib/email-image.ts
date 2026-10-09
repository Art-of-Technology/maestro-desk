import { Agent, fetch as safeFetch } from 'undici';
import { isIP } from 'node:net';
import { isBlockedAddress, safeLookup } from './ssrf.js';
import { sniffImageMime } from './image-sniff.js';

export const MAX_EMAIL_IMAGE_BYTES = 8 * 1024 * 1024;
const imageAgent = new Agent({ connect: { lookup: safeLookup }, headersTimeout: 8000, bodyTimeout: 8000 });

export function emailImageUrl(raw: string): string {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error('Unsupported image address');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isBlockedAddress(host)) throw new Error('Private image address');
  url.hash = '';
  return url.href;
}

// Fetch with Node's DNS-pinned dispatcher, never through the browser. Every
// redirect is checked; cookies, credentials and the email referrer are absent.
export async function fetchEmailImage(raw: string, signal: AbortSignal): Promise<Uint8Array> {
  let url = emailImageUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    const response = await safeFetch(url, { dispatcher: imageAgent, redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]), headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif', 'User-Agent': 'Respovia-Email-PDF/1.0' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Invalid image redirect');
      url = emailImageUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok || Number(response.headers.get('content-length')) > MAX_EMAIL_IMAGE_BYTES) {
      await response.body?.cancel();
      throw new Error('Image unavailable or too large');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty image');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_EMAIL_IMAGE_BYTES) throw new Error('Image too large');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const bytes = Buffer.concat(chunks);
    if (!sniffImageMime(bytes)) throw new Error('Unsupported image type');
    return bytes;
  }
  throw new Error('Too many image redirects');
}
