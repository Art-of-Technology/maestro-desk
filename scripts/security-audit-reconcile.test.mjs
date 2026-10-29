import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileAlert } from './security-audit-reconcile.mjs';

const pending = { name: 'security-audit-failure-123', startedAt: '2026-10-29T06:30:00.000Z' };
const existing = { 'security-audit-test-456': '2026-10-28T12:00:00.000Z' };
const now = () => new Date('2026-10-29T07:00:00.000Z');
function fixture({ noPending = false, active = { total_count: 0, workflow_runs: [] }, writeError, badVerification = false, readError } = {}) {
  let value = { version: 1, receipts: { ...existing }, pending: noPending ? null : { ...pending } };
  let sha = 'a'.repeat(40), writes = 0;
  const calls = [], output = [];
  return {
    calls, output, state: () => structuredClone(value),
    change: () => { sha = 'c'.repeat(40); value.receipts['security-audit-test-789'] = now().toISOString(); },
    log: message => output.push(message),
    api: async (route, method = 'GET', body) => {
      calls.push({ route, method, body });
      if (route.includes('/runs?')) {
        assert.equal(route, 'actions/workflows/security-audit-alerts.yml/runs?branch=main&status=in_progress&per_page=100');
        return active;
      }
      assert.ok(route.startsWith('contents/security-audit-receipts.json'), 'only receipt state and monitor status may be accessed');
      if (method === 'PUT') {
        if (writeError) throw Object.assign(new Error('private upstream details'), { status: writeError });
        assert.equal(body.branch, 'security-audit-state');
        assert.equal(body.sha, sha);
        value = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
        sha = 'b'.repeat(40);
        writes++;
        return { content: { sha } };
      }
      assert.equal(route, 'contents/security-audit-receipts.json?ref=security-audit-state');
      if (readError) throw new Error('private upstream details');
      return { sha: badVerification && writes ? 'd'.repeat(40) : sha, encoding: 'base64', content: Buffer.from(JSON.stringify(value)).toString('base64') };
    },
  };
}

test('no pending delivery exits without prompting or writing', async () => {
  const f = fixture({ noPending: true });
  const result = await reconcileAlert(f.api, () => assert.fail('must not prompt'), f.log, now);
  assert.equal(result.status, 'no-pending');
  assert.equal(f.calls.length, 1);
});

test('only explicit sent or unsent choices can change state', async () => {
  for (const choice of ['', 'leave unresolved', 'yes', 'sent', 'CONFIRMED SENT', undefined]) {
    const f = fixture();
    assert.equal((await reconcileAlert(f.api, async () => choice, f.log, now)).status, 'unresolved');
    assert.deepEqual(f.state().pending, pending);
    assert.equal(f.calls.length, 1);
    assert.match(f.output.join('\n'), /https:\/\/app.slack.com/);
    assert.match(f.output.join('\n'), /actions\/runs\/123/);
    assert.match(f.output.join('\n'), /actions\/workflows\/security-audit-alerts.yml/);
  }
});

test('confirmed sent adds only the pending receipt and verifies the saved state', async () => {
  const f = fixture();
  assert.equal((await reconcileAlert(f.api, async () => 'confirmed sent', f.log, now)).status, 'confirmed-sent');
  assert.deepEqual(f.state(), { version: 1, receipts: { ...existing, [pending.name]: now().toISOString() }, pending: null });
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
  assert.equal(f.calls.at(-1).method, 'GET');
});

test('confirmed unsent clears only pending, without manufacturing a receipt', async () => {
  const f = fixture();
  assert.equal((await reconcileAlert(f.api, async () => 'confirmed unsent', f.log, now)).status, 'confirmed-unsent');
  assert.deepEqual(f.state(), { version: 1, receipts: existing, pending: null });
  assert.match(f.output.at(-1), /later monitor may retry/);
});

test('a running monitor or changed state blocks reconciliation without overwrites', async () => {
  const busy = fixture({ active: { total_count: 1, workflow_runs: [{ status: 'in_progress' }] } });
  assert.equal((await reconcileAlert(busy.api, async () => 'confirmed unsent', busy.log, now)).status, 'busy');
  assert.ok(busy.calls.every(call => call.method === 'GET'));
  const changed = fixture();
  assert.equal((await reconcileAlert(changed.api, async () => { changed.change(); return 'confirmed sent'; }, changed.log, now)).status, 'state-changed');
  assert.ok(changed.calls.every(call => call.method === 'GET'));
  assert.deepEqual(changed.state().pending, pending);
  assert.ok(changed.state().receipts['security-audit-test-789']);
});

test('read, monitor lookup, write conflict and verification errors never report success', async () => {
  for (const options of [{ readError: true }, { active: {} }, { active: { total_count: 1, workflow_runs: [] } },
    { writeError: 409 }, { writeError: 403 }, { badVerification: true }]) {
    const f = fixture(options);
    await assert.rejects(reconcileAlert(f.api, async () => 'confirmed sent', f.log, now));
    assert.doesNotMatch(f.output.join('\n'), /Saved state verified|private upstream/);
  }
});

test('aborted prompts and invalid confirmation times preserve pending', async () => {
  const aborted = fixture();
  await assert.rejects(reconcileAlert(aborted.api, async () => { throw new Error('cancelled'); }, aborted.log, now));
  assert.equal(aborted.calls.length, 1);
  const clock = fixture();
  await assert.rejects(reconcileAlert(clock.api, async () => 'confirmed sent', clock.log, () => new Date('2026-10-28T00:00:00Z')));
  assert.ok(clock.calls.every(call => call.method === 'GET'));
  assert.deepEqual(clock.state().pending, pending);
});
