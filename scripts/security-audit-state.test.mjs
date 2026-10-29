import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAlertState, saveAlertState, migrateAlertState } from './security-audit-state.mjs';

const empty = () => ({ version: 1, receipts: {}, pending: null });
const cache = (id, key = `security-audit-failure-${id}`) => ({ id, key, ref: 'refs/heads/main', created_at: '2026-10-29T06:35:00Z' });
function fixture({ value, pages = [{ total_count: 0, actions_caches: [] }], readError, writeError, corruptSave = false } = {}) {
  let saved = value, sha = 'a'.repeat(40);
  const calls = [];
  return {
    calls, value: () => saved,
    api: async (route, method = 'GET', body) => {
      calls.push({ route, method, body });
      if (route.startsWith('contents/')) {
        if (method === 'PUT') {
          if (writeError) throw Object.assign(new Error('write failed'), { status: writeError });
          assert.equal(body.branch, 'security-audit-state');
          assert.equal(body.sha, saved ? sha : undefined);
          saved = corruptSave ? empty() : JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
          sha = 'b'.repeat(40);
          return { content: { sha } };
        }
        assert.equal(route, 'contents/security-audit-receipts.json?ref=security-audit-state');
        if (readError || !saved) throw Object.assign(new Error('read failed'), { status: readError || 404 });
        return { sha, encoding: 'base64', content: Buffer.from(JSON.stringify(saved)).toString('base64') };
      }
      if (route.startsWith('actions/caches?')) {
        assert.match(route, /key=security-audit-&ref=refs%2Fheads%2Fmain&per_page=100&page=/);
        return pages[Number(new URL(`https://api.test/${route}`).searchParams.get('page')) - 1];
      }
      if (route === 'git/ref/heads/security-audit-state') throw Object.assign(new Error('missing'), { status: 404 });
      if (route === 'git/ref/heads/main') return { object: { sha: 'c'.repeat(40) } };
      assert.equal(route, 'git/refs');
      assert.equal(method, 'POST');
      assert.equal(body.ref, 'refs/heads/security-audit-state');
      return {};
    },
  };
}

test('migration preserves every receipt type across pages and keeps the earliest duplicate receipt', async () => {
  const items = Array.from({ length: 100 }, (_, i) => cache(i + 1));
  const tail = [cache(101, 'security-audit-recovery-1'), cache(102, 'security-audit-test-2'),
    cache(103, 'security-audit-overdue-2026-10-29'), cache(104, 'security-audit-unknown-2026-10-29'),
    { ...cache(105, 'security-audit-failure-1'), created_at: '2026-10-29T07:35:00Z' },
    { ...cache(106), ref: 'refs/heads/untrusted' }];
  const f = fixture({ pages: [{ total_count: 106, actions_caches: items }, { total_count: 106, actions_caches: tail }] });
  const migrated = await migrateAlertState(f.api);
  assert.equal(Object.keys(migrated.value.receipts).length, 104);
  assert.equal(migrated.value.receipts['security-audit-failure-1'], '2026-10-29T06:35:00.000Z');
  assert.equal(migrated.value.pending, null);
  assert.deepEqual((await readAlertState(f.api)).value, migrated.value);
  const before = f.calls.length;
  await migrateAlertState(f.api);
  assert.equal(f.calls.length, before + 1, 'repeat migration must not read expired caches or overwrite durable state');
});

test('incomplete or invalid migration data never writes state', async () => {
  for (const pages of [
    [{ total_count: 1, actions_caches: [] }],
    [{ total_count: 2, actions_caches: [cache(1)] }, { total_count: 1, actions_caches: [cache(2)] }],
    [{ total_count: 2, actions_caches: [cache(1)] }, { total_count: 2, actions_caches: [cache(1)] }],
    [{ total_count: 1, actions_caches: [{ ...cache(1), created_at: 'bad' }] }],
    [{ total_count: 1, actions_caches: [cache(1, 'security-audit-invalid')] }],
  ]) {
    const f = fixture({ pages });
    await assert.rejects(migrateAlertState(f.api));
    assert.ok(f.calls.every(call => call.method === 'GET'));
  }
});

test('missing or corrupt durable state cannot silently reinitialize', async () => {
  await assert.rejects(readAlertState(fixture().api));
  for (const value of [null, {}, { ...empty(), receipts: [] }, { ...empty(), receipts: { bad: '2026-10-29T00:00:00.000Z' } },
    { ...empty(), receipts: { 'security-audit-failure-1': 'bad' } }, { ...empty(), pending: {} }]) {
    const f = fixture({ value: value ?? {} });
    await assert.rejects(migrateAlertState(f.api));
    assert.ok(f.calls.every(call => call.method === 'GET'));
  }
  const forbidden = fixture({ readError: 403 });
  await assert.rejects(migrateAlertState(forbidden.api));
  assert.equal(forbidden.calls.length, 1);
});

test('state writes require optimistic locking and successful read-back verification', async () => {
  for (const options of [{ writeError: 409 }, { writeError: 500 }, { corruptSave: true }]) {
    const f = fixture({ value: empty(), ...options });
    const state = await readAlertState(f.api);
    state.value.pending = { name: 'security-audit-test-123', startedAt: '2026-10-29T00:00:00.000Z' };
    await assert.rejects(saveAlertState(f.api, state));
  }
});
