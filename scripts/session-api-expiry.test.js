import { test, expect } from 'bun:test';

const stored = new Map();
globalThis.window = new EventTarget();
globalThis.sessionStorage = {
  getItem: key => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, value),
  removeItem: key => stored.delete(key),
};
const { apiGet, setJwt, setWorkspaceId } = await import('../web/js/core/api-client.js');

test('account and workspace changes invalidate private attachment caches only when the scope changes',()=>{
  stored.clear();let changes=0;
  const changed=()=>changes++;
  window.addEventListener('respovia:auth-scope-changed',changed);
  try {
    setJwt('agent');setWorkspaceId('workspace');expect(changes).toBe(2);
    setJwt('agent');setWorkspaceId('workspace');expect(changes).toBe(2);
    setWorkspaceId('other');setJwt(null);expect(changes).toBe(4);
  }finally{window.removeEventListener('respovia:auth-scope-changed',changed);stored.clear();}
});

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
