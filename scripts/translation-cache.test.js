import { test, expect, mock } from 'bun:test';

let workspace = 'workspace', calls = 0, response = 'Unknown', hold;
mock.module('../web/js/core/state.js', () => ({ SESSION: { userId: 'cache-test' } }));
mock.module('../web/js/core/api-client.js', () => ({ getJwt: () => 'test-jwt', getWorkspaceId: () => workspace }));
mock.module('../web/js/ai/client.js', () => ({ callClaude: async () => {
  calls++;
  const text = response;
  if (hold) await hold;
  return { text };
} }));
// Exercise the fallback used when browser storage is unavailable.
globalThis.indexedDB = { open() { throw new Error('Storage unavailable'); } };
const { messageTranslationRequest, translationScope } = await import('../web/js/ai/translation-cache.js');
const body = { system: 'Detect language', messages: [{ role: 'user', content: 'Hello, I need help with my account.' }] };
const request = (key, refresh = false) => messageTranslationRequest(key, translationScope(), 'text', { refresh })(body);
const until = async predicate => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 1));
  expect(predicate()).toBe(true);
};

test('Retry bypasses cached Unknown and replaces it for later reads', async () => {
  response = 'Unknown';
  expect((await request('retry')).text).toBe('Unknown');
  const before = calls;
  response = 'English';
  expect((await request('retry')).text).toBe('Unknown');
  expect(calls).toBe(before);
  expect((await request('retry', true)).text).toBe('English');
  expect((await request('retry')).text).toBe('English');
  expect(calls).toBe(before + 1);
});

test('concurrent retries share a fresh call after older work completes', async () => {
  const before = calls;
  let release;
  hold = new Promise(resolve => { release = resolve; });
  response = 'Unknown';
  const old = request('delayed');
  await until(() => calls === before + 1);
  const fresh = request('delayed', true);
  const duplicate = request('delayed', true);
  // Allow both hashes to finish while the old provider call is held.
  await new Promise(resolve => setTimeout(resolve, 20));
  response = 'English'; hold = null; release();
  expect((await old).text).toBe('Unknown');
  expect((await fresh).text).toBe('English');
  expect((await duplicate).text).toBe('English');
  expect((await request('delayed')).text).toBe('English');
  expect(calls).toBe(before + 2);
});

test('a refresh queued before a workspace switch never calls the provider', async () => {
  const before = calls;
  let release;
  hold = new Promise(resolve => { release = resolve; });
  const old = request('switch').catch(error => error);
  await until(() => calls === before + 1);
  const fresh = request('switch', true).catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 20));
  workspace = 'other'; hold = null; release();
  expect((await old).message).toContain('Workspace changed');
  expect((await fresh).message).toContain('Workspace changed');
  expect(calls).toBe(before + 1);
  workspace = 'workspace';
});
