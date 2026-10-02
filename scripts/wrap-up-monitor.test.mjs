import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingReport, alreadyAlerted, monitor } from './wrap-up-monitor.mjs';

const receipt = coverageThrough => ({ coverageThrough, verifiedAt: coverageThrough, channelId: 'C0C0W6B9PU6', messageTs: '123.456' });
const missing = (r, now, since = '2026-10-02') => missingReport(r, new Date(now), since);
const env = { GITHUB_REPOSITORY: 'Art-of-Technology/maestro-desk', GITHUB_REF: 'refs/heads/main',
  GITHUB_TOKEN: 'test', MONITOR_SINCE: '2026-10-02', SLACK_DEPLOY_WEBHOOK_URL: 'https://hooks.slack.com/services/test', GITHUB_RUN_ID: '123' };
const now = new Date('2026-10-02T17:35:00Z');
const record = { key: 'wrap-up-warning-2026-10-02', ref: 'refs/heads/main' };

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

test('cache records survive run-artifact loss and require an exact key and main ref', async () => {
  const read = a => async url => {
    assert.match(url, /actions\/caches\?key=/);
    return Response.json({ total_count: 1, actions_caches: [a] });
  };
  assert.equal(await alreadyAlerted(record.key, 'test', read(record)), true);
  for (const invalid of [{ ...record, key: 'other' }, { ...record, key: `${record.key}-extra` }, { ...record, ref: 'refs/pull/602/merge' }]) {
    assert.equal(await alreadyAlerted(record.key, 'test', read(invalid)), false);
  }
  await assert.rejects(alreadyAlerted(record.key, 'test', async () => Response.json({ total_count: 101, actions_caches: [] })));
  await assert.rejects(alreadyAlerted(record.key, 'test', async () => new Response('private', { status: 403 })));
});

test('offline end-to-end: missing report sends once, confirmed delivery and reruns do not send', async () => {
  let sent = 0, saved = false;
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (url.startsWith('https://api.github.com/')) return Response.json({ total_count: saved ? 1 : 0, actions_caches: saved ? [record] : [] });
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
  await assert.rejects(monitor(env, now, async url => url.startsWith('https://api.github.com/') ? Response.json({ total_count: 0, actions_caches: [] }) : new Response('no', { status: 500 })));
});

test('labelled live-test path uses a separate deduplication record', async () => {
  const result = await monitor({ ...env, MONITOR_MODE: 'test' }, now, async (url, options) => {
    if (url.startsWith('https://api.github.com/')) return Response.json({ total_count: 0, actions_caches: [] });
    assert.match(JSON.parse(options.body).text, /^TEST — Hosted/);
    return new Response('ok');
  });
  assert.equal(result.name, 'wrap-up-monitor-test-123');
});

test('hosted monitor reads durable state instead of a stale laptop receipt', async () => {
  const hosted = { coverageThrough: '2026-10-02T16:30:00Z', verifiedAt: '2026-10-02T16:32:00Z', channelId: 'C0C0W6B9PU6', transport: 'slack-webhook', runId: '789' };
  const result = await monitor({ ...env, HOSTED_WRAP_UP_ENABLED: 'true' }, now, async url => {
    assert.match(url, /contents\/wrap-up-state.json\?ref=codex-wrap-up-state/);
    return Response.json({ encoding: 'base64', sha: 'a'.repeat(40), content: Buffer.from(JSON.stringify({ version: 1, receipt: hosted, pending: null, lastDate: '2026-10-02', lastTestRun: null })).toString('base64') });
  });
  assert.equal(result.status, 'healthy');
});

test('unreadable hosted state still warns instead of trusting the stale laptop receipt', async () => {
  let sent = 0;
  const result = await monitor({ ...env, HOSTED_WRAP_UP_ENABLED: 'true', WRAP_UP_RECEIPT: JSON.stringify(receipt('2026-10-02T16:30:00Z')) }, now, async url => {
    if (url.includes('/contents/')) return new Response('missing', { status: 404 });
    if (url.includes('/actions/caches')) return Response.json({ total_count: 0, actions_caches: [] });
    sent++; return new Response('ok');
  });
  assert.equal(result.status, 'sent');
  assert.equal(sent, 1);
});
