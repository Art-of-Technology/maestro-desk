import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

export type PrivateFile = { kind: 'attachment' | 'knowledge'; id: string; workspaceId: string; storageKey: string };
function signature(file: PrivateFile, expires: string): Buffer {
  return createHmac('sha256', env.BETTER_AUTH_SECRET)
    .update(JSON.stringify(['respovia-private-file-v1', file.kind, file.id, file.workspaceId, file.storageKey, expires])).digest();
}

// A file-only bearer link, as before, but served by the API so suspension and
// deletion are checked on every fetch. Never expose the underlying R2 URL.
export function privateFileUrl(file: PrivateFile, seconds = 300): string {
  const expires = String(Math.floor(Date.now() / 1000) + seconds);
  const url = new URL(`/api/v1/files/${file.kind}/${file.id}`, env.BETTER_AUTH_URL);
  url.searchParams.set('expires', expires);
  url.searchParams.set('signature', signature(file, expires).toString('base64url'));
  return url.href;
}

export function validPrivateFileLink(file: PrivateFile, expires: string, supplied: string): boolean {
  if (!/^\d{10}$/.test(expires) || Number(expires) <= Date.now() / 1000 || !/^[\w-]{43}$/.test(supplied)) return false;
  const actual = Buffer.from(supplied, 'base64url');
  const expected = signature(file, expires);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
