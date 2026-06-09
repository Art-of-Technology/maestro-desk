import { AwsClient } from 'aws4fetch';
import { env } from './env.ts';

// Cloudflare R2 storage (migration to Neon — Step 4).
//
// Replaces Supabase Storage for brand-asset uploads (workspace logos). R2 is
// S3-compatible, so we sign plain `fetch` requests with aws4fetch (SigV4) and
// talk to the bucket's S3 endpoint directly — no AWS SDK. This keeps the same
// code working on Bun locally and on Node when the API moves to Vercel
// (Step 6); aws4fetch uses only `fetch` + Web Crypto, both runtime-agnostic.
//
// Lazy + memoised, mirroring lib/db.ts: importing this module never reads
// credentials or throws, so the API still boots while R2 is unconfigured
// (only the logo-upload path needs it). The client is built on first use.

let _client: AwsClient | null = null;

// R2's S3 API uses a fixed pseudo-region.
const R2_REGION = 'auto';

function requireR2(): { client: AwsClient; endpoint: string; bucket: string; publicBase: string } {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_PUBLIC_BASE_URL) {
    throw new Error(
      'Cloudflare R2 is not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, ' +
        'R2_SECRET_ACCESS_KEY and R2_PUBLIC_BASE_URL in api/.env (see api/.env.example).',
    );
  }
  if (!_client) {
    _client = new AwsClient({
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
      region: R2_REGION,
      service: 's3',
    });
  }
  return {
    client: _client,
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    bucket: R2_BUCKET,
    // Tolerate a trailing slash in the configured base so publicUrl() never
    // produces a `//` in the path.
    publicBase: R2_PUBLIC_BASE_URL.replace(/\/+$/, ''),
  };
}

// URI-encode an object key for use in a URL path: each "/"-delimited segment is
// encoded, but the slashes between segments are preserved (S3 treats the key as
// a path). aws4fetch canonicalises the same URL for signing, so the signature
// matches what we send. Exported for unit testing.
export function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function objectUrl(endpoint: string, bucket: string, key: string): string {
  return `${endpoint}/${bucket}/${encodeKey(key)}`;
}

// PUT an object. Throws on a non-2xx response (the caller maps that to a 500).
export async function putObject(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const { client, endpoint, bucket } = requireR2();
  const res = await client.fetch(objectUrl(endpoint, bucket, key), {
    method: 'PUT',
    body: bytes,
    headers: { 'Content-Type': contentType },
  });
  if (!res.ok) {
    throw new Error(`R2 PUT ${key} failed: ${res.status} ${await res.text().catch(() => '')}`.trim());
  }
}

// List object keys under a prefix (ListObjectsV2). Returns the full keys
// (including the prefix). Our keys are safe ASCII (uuid/logo-<ts>.<ext>), so a
// simple <Key> scan over the XML response is sufficient.
export async function listKeys(prefix: string): Promise<string[]> {
  const { client, endpoint, bucket } = requireR2();
  const url = `${endpoint}/${bucket}?list-type=2&prefix=${encodeURIComponent(prefix)}`;
  const res = await client.fetch(url, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`R2 LIST ${prefix} failed: ${res.status} ${await res.text().catch(() => '')}`.trim());
  }
  return parseListKeysXml(await res.text());
}

// Extract object keys from a ListObjectsV2 XML response. Our keys are safe
// ASCII (uuid/logo-<ts>.<ext>), so a simple <Key> scan + entity decode is
// sufficient — no XML parser needed. Exported for unit testing.
export function parseListKeysXml(xml: string): string[] {
  return [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => decodeXmlEntities(m[1]));
}

// Delete objects by key. Best-effort per-object DELETE (R2 treats DELETE on a
// missing key as success), run concurrently. Used for logo cleanup where the
// stale set is tiny (one prior file).
export async function deleteKeys(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const { client, endpoint, bucket } = requireR2();
  await Promise.all(
    keys.map(async (key) => {
      const res = await client.fetch(objectUrl(endpoint, bucket, key), { method: 'DELETE' });
      // 204 on delete, 404 if already gone — both are fine.
      if (!res.ok && res.status !== 404) {
        throw new Error(`R2 DELETE ${key} failed: ${res.status}`);
      }
    }),
  );
}

// Public read URL for a stored object, built from the bucket's configured
// public base (r2.dev URL or custom domain). The base is not signed — public
// access is granted at the bucket level in Cloudflare.
export function publicUrl(key: string): string {
  const { publicBase } = requireR2();
  return `${publicBase}/${encodeKey(key)}`;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
