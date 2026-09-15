import { test, expect } from 'bun:test';
import { publicFrontendFiles, verifyFrontend, waitForFrontend } from './frontend-deployment-check.mjs';

const files = [{ path: 'index.html', content: Buffer.from('new page') }, { path: 'js/app.js', content: Buffer.from('new code') }];
test('excludes build and hosting configuration', () => {
  expect(publicFrontendFiles(['web/index.html', 'web/js/app.js', 'web/Dockerfile', 'web/nginx.conf', 'web/vercel.json', 'web/.dockerignore', 'api/index.ts']))
    .toEqual(['web/index.html', 'web/js/app.js']);
});
test('healthy but old or mixed frontend fails, matching bytes pass', async () => {
  expect(await verifyFrontend('https://example.test', files, { fetchImpl: async () => new Response('old content') })).toHaveLength(2);
  expect(await verifyFrontend('https://example.test', files, { fetchImpl: async url => new Response(url.pathname === '/index.html' ? 'new page' : 'old code') })).toHaveLength(1);
  expect(await verifyFrontend('https://example.test', files, { fetchImpl: async url => {
    expect(url.searchParams.has('deploy_check')).toBe(true);
    return new Response(url.pathname === '/index.html' ? 'new page' : 'new code');
  } })).toEqual([]);
});
test('missing files and network errors fail', async () => {
  expect(await verifyFrontend('https://example.test', files, { fetchImpl: async () => new Response('missing', { status: 404 }) })).toHaveLength(2);
  expect(await verifyFrontend('https://example.test', files, { fetchImpl: async () => { throw new Error('offline'); } })).toHaveLength(2);
});
test('binary bytes are compared without text decoding', async () => {
  const binary = [{ path: 'asset.png', content: Buffer.from([0, 255, 254]) }];
  expect(await verifyFrontend('https://example.test', binary, { fetchImpl: async () => new Response(new Uint8Array([0, 255, 254])) })).toEqual([]);
  expect(await verifyFrontend('https://example.test', binary, { fetchImpl: async () => new Response(new Uint8Array([0, 254, 255])) })).toHaveLength(1);
});
test('retries until deployed and fails when stale version persists', async () => {
  let calls = 0, pauses = 0;
  await waitForFrontend('https://example.test', files, { verify: async () => ++calls < 3 ? ['old'] : [], pause: async () => { pauses++; }, log: () => {} });
  expect(calls).toBe(3); expect(pauses).toBe(2);
  await expect(waitForFrontend('https://example.test', files, { attempts: 2, verify: async () => ['old'], pause: async () => {}, log: () => {} })).rejects.toThrow('not verified');
  await expect(waitForFrontend('https://example.test', [])).rejects.toThrow('No frontend files');
});
