// R2 store: presigned GET URLs, Content-Disposition hardening, and the
// "attachments bucket not configured" contract. Pure unit tests — a store is
// built from fixed credentials, so nothing reads env or touches the network.

import { describe, expect, test } from 'bun:test';
import {
  attachmentsStore,
  contentDispositionFor,
  createStore,
  isAttachmentsStorageConfigured,
  PRESIGN_DEFAULT_EXPIRES_SECONDS,
} from './lib/r2.js';

const cfg = {
  accountId: 'acct123',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  bucket: 'respovia-attachments',
};
const DATETIME = '20260905T120000Z';

describe('presignGet', () => {
  test('signs the object URL with query-string SigV4 and the requested expiry', async () => {
    const store = createStore(cfg);
    const href = await store.presignGet('att/ws-1/tk-1/uuid-1/report.pdf', { expiresSeconds: 3600, datetime: DATETIME });
    const url = new URL(href);
    expect(url.origin).toBe('https://acct123.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/respovia-attachments/att/ws-1/tk-1/uuid-1/report.pdf');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Credential')).toBe('AKIAEXAMPLE/20260905/auto/s3/aws4_request');
    expect(url.searchParams.get('X-Amz-Date')).toBe(DATETIME);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  test('defaults to the 6-hour lifetime, not aws4fetch’s 24 h', async () => {
    const href = await createStore(cfg).presignGet('k', { datetime: DATETIME });
    expect(new URL(href).searchParams.get('X-Amz-Expires')).toBe(String(PRESIGN_DEFAULT_EXPIRES_SECONDS));
    expect(PRESIGN_DEFAULT_EXPIRES_SECONDS).toBe(21600);
  });

  test('is deterministic for a fixed datetime and differs per key', async () => {
    const store = createStore(cfg);
    const a1 = await store.presignGet('a', { datetime: DATETIME });
    const a2 = await store.presignGet('a', { datetime: DATETIME });
    const b = await store.presignGet('b', { datetime: DATETIME });
    expect(a1).toBe(a2);
    expect(new URL(a1).searchParams.get('X-Amz-Signature')).not.toBe(new URL(b).searchParams.get('X-Amz-Signature'));
  });

  test('percent-encodes filename characters per segment and keeps slashes', async () => {
    const href = await createStore(cfg).presignGet('att/ws/tk/id/my report (final)+v2.pdf', { datetime: DATETIME });
    const { pathname } = new URL(href);
    expect(pathname).toBe('/respovia-attachments/att/ws/tk/id/my%20report%20(final)%2Bv2.pdf');
  });
});

describe('contentDispositionFor', () => {
  test('plain ASCII filename', () => {
    expect(contentDispositionFor('attachment', 'report.pdf')).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  test('inline kind for images', () => {
    expect(contentDispositionFor('inline', 'photo.png').startsWith('inline; filename="photo.png"')).toBe(true);
  });

  test('strips header-injection characters (CR/LF/quotes/backslash)', () => {
    const v = contentDispositionFor('attachment', 'evil"\r\nX-Injected: 1\\.pdf');
    expect(v).not.toMatch(/[\r\n]/);
    expect(v.split('"').length).toBe(3); // exactly one quoted filename
    expect(v).toContain('filename="evil_ X-Injected: 1_.pdf"');
  });

  test('non-ASCII goes into filename* only, with an ASCII fallback', () => {
    const v = contentDispositionFor('attachment', 'résumé ✓.pdf');
    expect(v).toContain('filename="r_sum_ _.pdf"');
    expect(v).toContain(`filename*=UTF-8''r%C3%A9sum%C3%A9%20%E2%9C%93.pdf`);
    // eslint-disable-next-line no-control-regex
    expect(v).not.toMatch(/[^\x20-\x7e]/);
  });

  test('empty or whitespace names fall back to "file" and long names are capped', () => {
    expect(contentDispositionFor('attachment', '   ')).toContain('filename="file"');
    const long = 'a'.repeat(500) + '.pdf';
    expect(contentDispositionFor('attachment', long).length).toBeLessThan(500);
  });
});

describe('attachments bucket configuration contract', () => {
  test('is not configured in the test environment', () => {
    expect(isAttachmentsStorageConfigured()).toBe(false);
  });

  test('deleteKeys([]) is a no-op that never needs config (erasure/retention call it unconditionally)', async () => {
    await expect(attachmentsStore().deleteKeys([])).resolves.toBeUndefined();
  });

  test('a real operation fails with a clear "not configured" error', async () => {
    await expect(attachmentsStore().putObject('k', new Uint8Array([1]), { contentType: 'text/plain' })).rejects.toThrow(
      /not configured/,
    );
  });
});
