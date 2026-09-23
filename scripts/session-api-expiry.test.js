import { test, expect } from 'bun:test';

const stored = new Map();
globalThis.window = new EventTarget();
globalThis.sessionStorage = {
  getItem: key => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, value),
  removeItem: key => stored.delete(key),
};
const { apiGet, setJwt } = await import('../web/js/core/api-client.js');

test('401 expires only the session that made the request, never a newer login or a public request', async () => {
  let expired = 0;
  window.addEventListener('respovia:session-expired', () => expired++);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{"error":"Invalid or missing session"}', { status: 401 });
    setJwt('old');
    await expect(apiGet('/test')).rejects.toMatchObject({ status: 401 });
    expect(expired).toBe(1);
    globalThis.fetch = async () => {
      setJwt('new-login');
      return new Response('{}', { status: 401 });
    };
    await expect(apiGet('/test')).rejects.toMatchObject({ status: 401 });
    expect(expired).toBe(1);
    await expect(apiGet('/public', { auth: false })).rejects.toMatchObject({ status: 401 });
    expect(expired).toBe(1);
    globalThis.fetch = async () => new Response('{}', { status: 403 });
    await expect(apiGet('/forbidden')).rejects.toMatchObject({ status: 403 });
    expect(expired).toBe(1);
  } finally { globalThis.fetch = original; }
});
