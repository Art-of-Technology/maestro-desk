import { afterEach, expect, test, spyOn } from 'bun:test';
import dns from 'node:dns/promises';
import type { LookupAddress, LookupAllOptions, LookupOneOptions, LookupOptions } from 'node:dns';
import * as undici from 'undici';
import { fetchKnowledgePage, checkKnowledgeLink } from './lib/knowledge-import.js';
import { SPACE_CASINO_WORKSPACE } from './lib/knowledge-market-policy.js';

const mocks: { mockRestore(): void }[] = [];
test('link checks distinguish missing pages from blocked or restricted checks',async()=>{
  const fetch=setup([new undici.Response(null,{status:404}),new undici.Response(null,{status:403}),new undici.Response(null,{status:200})]);
  expect(await checkKnowledgeLink('https://example.com/missing','workspace')).toBe('broken');
  expect(await checkKnowledgeLink('https://example.com/private','workspace')).toBe('unverified');
  expect(await checkKnowledgeLink('https://example.com/pdf','workspace')).toBe('ok');
  expect(fetch.mock.calls[0][1]?.dispatcher).toBeTruthy();
  expect(await checkKnowledgeLink('http://example.com','workspace')).toBe('unverified');
  expect(fetch).toHaveBeenCalledTimes(3);
});
test('link checks block internal redirects and excluded markets',async()=>{
  const fetch=setup([new undici.Response(null,{status:302,headers:{Location:'https://127.0.0.1/private'}})]);
  expect(await checkKnowledgeLink('https://example.com','workspace')).toBe('unverified');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await checkKnowledgeLink('https://www.spacecasino.com/pt-br/help',SPACE_CASINO_WORKSPACE)).toBe('unverified');
  expect(fetch).toHaveBeenCalledTimes(1);
});
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

test('blocks excluded Space Casino markets before fetching and after redirects', async () => {
  const fetch = setup([new undici.Response(null, { status: 302, headers: { Location: '/es-pe/help' } })]);
  await expect(fetchKnowledgePage('https://www.spacecasino.com/pt-br/help', SPACE_CASINO_WORKSPACE)).rejects.toThrow('no longer supported');
  expect(fetch).toHaveBeenCalledTimes(0);
  await expect(fetchKnowledgePage('https://www.spacecasino.com/help', SPACE_CASINO_WORKSPACE)).rejects.toThrow('no longer supported');
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('does not apply Space Casino exclusions to a different workspace', async () => {
  const fetch = setup([new undici.Response('<h1>Help</h1>', { headers: { 'content-type': 'text/html' } })]);
  expect(new TextDecoder().decode(await fetchKnowledgePage('https://www.spacecasino.com/pt-br/help', 'other-workspace'))).toContain('Help');
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
