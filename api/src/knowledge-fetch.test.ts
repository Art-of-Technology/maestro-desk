import { afterEach, expect, test, spyOn } from 'bun:test';
import dns from 'node:dns/promises';
import type { LookupAddress, LookupAllOptions, LookupOneOptions, LookupOptions } from 'node:dns';
import * as undici from 'undici';
import { fetchKnowledgePage } from './lib/knowledge-import.js';

const mocks: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const m of mocks.splice(0)) m.mockRestore();
});
function publicLookup(hostname: string, options: LookupAllOptions): Promise<LookupAddress[]>;
function publicLookup(hostname: string, options: LookupOneOptions | number): Promise<LookupAddress>;
function publicLookup(
  hostname: string,
  options: LookupOptions,
): Promise<LookupAddress | LookupAddress[]>;
function publicLookup(hostname: string): Promise<LookupAddress>;
async function publicLookup(
  _hostname: string,
  options?: LookupOptions | number,
): Promise<LookupAddress | LookupAddress[]> {
  const address = { address: '93.184.216.34', family: 4 };
  return typeof options === 'object' && options.all ? [address] : address;
}
function setup(responses: undici.Response[]) {
  mocks.push(spyOn(dns, 'lookup').mockImplementation(publicLookup));
  const fetch = spyOn(undici, 'fetch').mockImplementation(async () => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected extra fetch');
    return response;
  });
  mocks.push(fetch);
  return fetch;
}
test('fetches HTML and follows a relative redirect with the protected dispatcher', async () => {
  const fetch = setup([
    new undici.Response(null, { status: 302, headers: { Location: '/policy' } }),
    new undici.Response('<h1>Policy</h1>', { headers: { 'content-type': 'text/html' } }),
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
    new undici.Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/private' } }),
  ]);
  await expect(fetchKnowledgePage('https://example.com')).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
test('reports refusals and rejects non-HTML and oversized pages', async () => {
  const fetch = setup([
    new undici.Response('denied', { status: 403 }),
    new undici.Response('{}', { headers: { 'content-type': 'application/json' } }),
    new undici.Response('a'.repeat(2 * 1024 * 1024 + 1), {
      headers: { 'content-type': 'text/html' },
    }),
  ]);
  await expect(fetchKnowledgePage('https://example.com')).rejects.toThrow('HTTP 403');
  await expect(fetchKnowledgePage('https://example.com')).rejects.toThrow('Use a public HTML page');
  await expect(fetchKnowledgePage('https://example.com')).rejects.toThrow('2 MB');
  expect(fetch).toHaveBeenCalledTimes(3);
});
