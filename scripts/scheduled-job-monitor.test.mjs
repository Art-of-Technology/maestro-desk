import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deadlines, overdueJobs, readHistory, overdueText } from './scheduled-job-monitor.mjs';

const now = Date.parse('2026-09-24T12:00:00Z');
const hour = 3_600_000;
const activatedAt = now - 48 * hour;
const success = (job, age = 0) => ({ display_title: `Scheduled job - ${job}`, created_at: new Date(now - age).toISOString(), event: 'schedule', head_branch: 'main', status: 'completed', conclusion: 'success' });
const healthy = () => Object.keys(deadlines).map(job => success(job));

test('normal delays and exact deadlines are healthy, each overdue job is reported', () => {
  const runs = Object.entries(deadlines).map(([job, limit]) => success(job, limit));
  assert.deepEqual(overdueJobs(runs, now, activatedAt), []);
  assert.equal(overdueJobs(runs, now + 1, activatedAt).length, 4);
  assert.deepEqual(overdueJobs(healthy(), now, activatedAt), []);
});
test('failures, cancellations, manual runs, other branches and malformed dates cannot hide a missed schedule', () => {
  for (const change of [{ conclusion: 'failure' }, { conclusion: 'cancelled' }, { status: 'in_progress' }, { event: 'workflow_dispatch' }, { head_branch: 'feature' }, { created_at: 'bad' }, { created_at: new Date(now + hour).toISOString() }]) {
    const runs = healthy().map(run => run.display_title.endsWith('knowledge-refresh') ? { ...run, ...change } : run);
    assert.deepEqual(overdueJobs(runs, now, activatedAt).map(x => x.job), ['knowledge-refresh']);
  }
});
test('missing history gets one deadline of rollout grace, and a later success clears the warning', () => {
  assert.deepEqual(overdueJobs([], now, now), []);
  assert.deepEqual(overdueJobs([], now, now - 2 * hour).map(x => x.job), ['knowledge-refresh']);
  assert.equal(overdueJobs([], now, activatedAt).length, 4);
  assert.deepEqual(overdueJobs(healthy(), now, activatedAt), []);
  assert.throws(() => overdueJobs([], now, NaN));
  assert.match(overdueText(overdueJobs([], now, activatedAt)), /retention: no successful scheduled run within 30 hours/);
});
test('history is paginated so frequent jobs do not hide daily successes', async () => {
  const calls = [];
  const result = await readHistory('test-token', now, async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    if (url.endsWith('scheduled-job-monitor.yml')) return Response.json({ created_at: new Date(activatedAt).toISOString() });
    return Response.json({ total_count: 101, workflow_runs: url.endsWith('page=1') ? Array.from({ length: 100 }, () => success('knowledge-refresh')) : [success('retention')] });
  });
  assert.equal(result.runs.length, 101);
  assert.equal(calls.length, 3);
  assert.equal(overdueJobs(result.runs, now, activatedAt).some(x => x.job === 'retention'), false);
});
test('API errors and incomplete history fail visibly instead of claiming health', async () => {
  await assert.rejects(readHistory('test', now, async () => new Response('private', { status: 403 })));
  await assert.rejects(readHistory('test', now, async url => Response.json(url.endsWith('scheduled-job-monitor.yml') ? { created_at: new Date(activatedAt).toISOString() } : { total_count: 1001, workflow_runs: [] })));
});
