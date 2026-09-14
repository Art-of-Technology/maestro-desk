import { afterEach, expect, test, spyOn } from 'bun:test';
import dns from 'node:dns/promises';
import * as undici from 'undici';
import { fetchKnowledgePage } from './lib/knowledge-import.js';

const mocks: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const m of mocks.splice(0)) m.mockRestore();
});
function setup(responses: Response[]) {
  mocks.push(
    spyOn(dns, 'lookup').mockImplementation(
      async () => [{ address: '93.184.216.34', family: 4 }] as any,
    ),
  );
  const fetch = spyOn(undici, 'fetch').mockImplementation(async () => responses.shift() as any);
  mocks.push(fetch);
  return fetch;
}
test('fetches HTML and follows a relative redirect with the protected dispatcher', async () => {
  const fetch = setup([
    new Response(null, { status: 302, headers: { Location: '/policy' } }),
    new Response('<h1>Policy</h1>', { headers: { 'content-type': 'text/html' } }),
  ]);
  expect(new TextDecoder().decode(await fetchKnowledgePage('https://example.com/start'))).toBe(
    '<h1>Policy</h1>',
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1][0]).toBe('https://example.com/policy');
  expect(fetch.mock.calls[0][1]?.redirect).toBe('manual');
  expect(fetch.mock.calls[0][1]?.dispatcher).toBeTruthy();
});
test('blocks redirects into internal addresses before a second request', async () => {
  const fetch = setup([
    new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/private' } }),
  ]);
  await expect(fetchKnowledgePage('https://example.com')).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
test('reports refusals and rejects non-HTML and oversized pages', async () => {
  const fetch = setup([
    new Response('denied', { status: 403 }),
    new Response('{}', { headers: { 'content-type': 'application/json' } }),
    new Response('a'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'text/html' } }),
  ]);
  await expect(fetchKnowledgePage('https://example.com')).rejects.toThrow('HTTP 403');
  await expect(fetchKnowledgePage('https://example.com')).rejects.toThrow('Use a public HTML page');
  await expect(fetchKnowledgePage('https://example.com')).rejects.toThrow('2 MB');
  expect(fetch).toHaveBeenCalledTimes(3);
});
