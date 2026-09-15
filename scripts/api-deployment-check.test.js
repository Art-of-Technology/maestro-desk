import { expect, test } from 'bun:test';
import { verifyApi, waitForApi } from './api-deployment-check.mjs';
const expected = 'a'.repeat(64);
const response = body => new Response(JSON.stringify(body));

test('healthy old API, missing fingerprint and mixed readiness cannot pass', async () => {
  for (const body of [{ ok: true }, { ok: true, buildFingerprint: 'b'.repeat(64) }, { ok: false, buildFingerprint: expected }]) {
    await expect(verifyApi('https://example.test', expected, async () => response(body))).rejects.toThrow('not ready');
  }
  await expect(verifyApi('https://example.test', expected, async url => response({ ok: true, buildFingerprint: url.pathname.endsWith('/ready') ? 'b'.repeat(64) : expected }))).rejects.toThrow('not ready');
});
test('requires matching version and readiness; network and malformed responses fail', async () => {
  const paths = [];
  await verifyApi('https://example.test', expected, async url => {
    paths.push(url.pathname);
    expect(url.searchParams.has('deploy_check')).toBe(true);
    return response({ ok: true, buildFingerprint: expected });
  });
  expect(paths).toEqual(['/api/v1/health', '/api/v1/health/ready']);
  await expect(verifyApi('https://example.test', expected, async () => new Response('unavailable', { status: 503 }))).rejects.toThrow('HTTP 503');
  await expect(verifyApi('https://example.test', expected, async () => new Response('not JSON'))).rejects.toThrow();
  await expect(verifyApi('https://example.test', expected, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
});
test('retries deployment and fails after persistent mismatch', async () => {
  let calls = 0;
  await waitForApi('https://example.test', expected, { verify: async () => { if (++calls < 3) throw new Error('old'); }, pause: async () => {}, log: () => {} });
  expect(calls).toBe(3);
  await expect(waitForApi('https://example.test', expected, { attempts: 2, verify: async () => { throw new Error('old'); }, pause: async () => {}, log: () => {} })).rejects.toThrow('not verified');
});
