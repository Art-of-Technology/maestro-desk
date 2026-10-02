import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingReport, alreadyAlerted, monitor } from './wrap-up-monitor.mjs';

const receipt = coverageThrough => ({ coverageThrough, verifiedAt: coverageThrough, channelId: 'C0C0W6B9PU6', messageTs: '123.456' });
const missing = (r, now, since = '2026-10-02') => missingReport(r, new Date(now), since);
const env = { GITHUB_REPOSITORY: 'Art-of-Technology/maestro-desk', GITHUB_REF: 'refs/heads/main',
  GITHUB_TOKEN: 'test', MONITOR_SINCE: '2026-10-02', SLACK_DEPLOY_WEBHOOK_URL: 'https://hooks.slack.com/services/test', GITHUB_RUN_ID: '123' };
const now = new Date('2026-10-02T17:35:00Z');
const artifact = { name: 'wrap-up-warning-2026-10-02', expired: false,
  workflow_run: { head_branch: 'main', repository_id: 1, head_repository_id: 1 } };

test('deadline, morning catch-up, late report, downtime, weekends and GMT/BST', () => {
  assert.equal(missing(null, '2026-10-02T17:29:59Z'), null);
  assert.equal(missing(null, '2026-10-02T17:30:00Z'), '2026-10-02');
  assert.equal(missing(receipt('2026-10-02T08:36:57Z'), now), '2026-10-02');
  assert.equal(missing(receipt('2026-10-02T16:30:00Z'), now), null);
  assert.equal(missing(receipt('2026-10-02T17:34:00Z'), now), null);
  assert.equal(missing(null, '2026-10-03T18:35:00Z'), '2026-10-02');
  assert.equal(missing(null, '2026-10-05T08:00:00Z'), '2026-10-02');
  assert.equal(missing(null, '2026-10-26T18:29:59Z'), '2026-10-23');
  assert.equal(missing(null, '2026-10-26T18:30:00Z'), '2026-10-26');
  assert.equal(missing(null, '2027-03-29T17:30:00Z'), '2027-03-29');
  for (const invalid of [receipt('bad'), receipt('2026-10-03T16:30:00Z'), { ...receipt('2026-10-02T16:30:00Z'), messageTs: '' }, { ...receipt('2026-10-02T16:30:00Z'), channelId: 'other' }]) {
    assert.equal(missing(invalid, now), '2026-10-02');
  }
  assert.throws(() => missingReport(null, now, ''));
});

test('alert records suppress duplicates; wrong branch, fork and expired records do not', async () => {
  const read = a => async () => Response.json({ total_count: 1, artifacts: [a] });
  assert.equal(await alreadyAlerted(artifact.name, 'test', read(artifact)), true);
  for (const invalid of [{ ...artifact, expired: true }, { ...artifact, name: 'other' },
    { ...artifact, workflow_run: { ...artifact.workflow_run, head_branch: 'feature' } },
    { ...artifact, workflow_run: { ...artifact.workflow_run, head_repository_id: 2 } }]) {
    assert.equal(await alreadyAlerted(artifact.name, 'test', read(invalid)), false);
  }
  await assert.rejects(alreadyAlerted(artifact.name, 'test', async () => Response.json({ total_count: 101, artifacts: [] })));
  await assert.rejects(alreadyAlerted(artifact.name, 'test', async () => new Response('private', { status: 403 })));
});

test('offline end-to-end: missing report sends once, confirmed delivery and reruns do not send', async () => {
  let sent = 0, saved = false;
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (url.startsWith('https://api.github.com/')) return Response.json({ total_count: saved ? 1 : 0, artifacts: saved ? [artifact] : [] });
    assert.match(JSON.parse(options.body).text, /DAILY WRAP-UP MISSING/);
    sent++;
    return new Response('ok');
  };
  assert.equal((await monitor(env, now, fetchImpl)).status, 'sent');
  saved = true;
  assert.equal((await monitor(env, now, fetchImpl)).status, 'already-alerted');
  assert.equal((await monitor({ ...env, WRAP_UP_RECEIPT: JSON.stringify(receipt('2026-10-02T16:30:00Z')) }, now, fetchImpl)).status, 'healthy');
  assert.equal(sent, 1);
  await assert.rejects(monitor({ ...env, GITHUB_REF: 'refs/heads/feature' }, now, fetchImpl));
  await assert.rejects(monitor(env, now, async url => url.startsWith('https://api.github.com/') ? Response.json({ total_count: 0, artifacts: [] }) : new Response('no', { status: 500 })));
});

test('labelled live-test path uses a separate deduplication record', async () => {
  const result = await monitor({ ...env, MONITOR_MODE: 'test' }, now, async (url, options) => {
    if (url.startsWith('https://api.github.com/')) return Response.json({ total_count: 0, artifacts: [] });
    assert.match(JSON.parse(options.body).text, /^TEST — Hosted/);
    return new Response('ok');
  });
  assert.equal(result.name, 'wrap-up-monitor-test-123');
});
