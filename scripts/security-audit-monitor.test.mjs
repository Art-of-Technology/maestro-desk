import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expectedScan, inspectAudit, monitor } from './security-audit-monitor.mjs';

const now = new Date('2026-10-28T08:35:00Z');
const env = {
  GITHUB_REPOSITORY: 'Art-of-Technology/maestro-desk', GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'schedule', GITHUB_RUN_ID: '800', GITHUB_TOKEN: 'test-token',
  SLACK_DEPLOY_WEBHOOK_URL: 'https://hooks.slack.com/services/test/offline/only',
};
const run = (overrides = {}) => ({
  id: 123, run_attempt: 2, name: 'Dependency security audit', path: '.github/workflows/dependency-security-audit.yml',
  head_repository: { full_name: env.GITHUB_REPOSITORY }, head_branch: 'main',
  event: 'schedule', created_at: '2026-10-28T06:30:00Z', updated_at: '2026-10-28T07:30:00Z', status: 'completed', conclusion: 'success',
  ...overrides,
});

function fixture(runs = [], { cached = [], historyError = false, deliveryError = false, cacheError = false, total = runs.length, current = runs[0], jobs = { total_count: 0, jobs: [] }, recoveryRuns = runs, recoveryTotal = recoveryRuns.length, failed = run({ conclusion: 'failure', updated_at: '2026-10-28T06:31:00Z' }), receipts } = {}) {
  const calls = [], messages = [];
  return {
    calls, messages,
    fetch: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.redirect, 'error');
      if (url.startsWith('https://hooks.slack.com/')) {
        messages.push(JSON.parse(options.body).text);
        assert.equal(options.headers.Authorization, undefined);
        if (deliveryError) throw new Error('sensitive upstream error');
        return new Response('ok');
      }
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      if (url.includes('/actions/caches?')) {
        if (cacheError) return new Response('', { status: 403 });
        return Response.json((new URL(url).searchParams.get('key') === 'security-audit-failure-' && receipts) || { actions_caches: cached.map(key => ({ key, ref: 'refs/heads/main', created_at: '2026-10-28T06:32:00Z' })), total_count: cached.length });
      }
      if (historyError) throw new Error('private upstream details');
      if (url.includes('/jobs?')) return Response.json(jobs);
      if (url.includes('/actions/runs/')) return Response.json(url.endsWith(`/actions/runs/${current?.id}`) || (!cached.length && !receipts) ? current : failed);
      if (url.includes('/runs?branch=main&created=')) return Response.json({ workflow_runs: recoveryRuns, total_count: recoveryTotal });
      assert.match(url, /event=schedule&branch=main&created=/);
      return Response.json({ workflow_runs: runs, total_count: total });
    },
  };
}

test('UTC grace switches expected date exactly at 08:15, including month/year and DST boundaries', () => {
  for (const [time, date] of [
    ['2026-10-28T08:14:59Z', '2026-10-27'], ['2026-10-28T08:15:00Z', '2026-10-28'],
    ['2027-01-01T07:00:00Z', '2026-12-31'], ['2026-03-29T08:15:00Z', '2026-03-29'],
    ['2026-10-25T08:15:00Z', '2026-10-25'],
  ]) {
    const expected = expectedScan(new Date(time));
    assert.equal(expected.date, date);
    assert.equal(new Date(expected.start).toISOString(), `${date}T06:15:00.000Z`);
    assert.equal(expected.end - expected.start, 86_400_000);
  }
});

test('successful scheduled scan without a confirmed failure remains quiet', async () => {
  const f = fixture([run()]);
  assert.deepEqual(await monitor(env, {}, now, f.fetch), { status: 'healthy' });
  assert.equal(f.calls.length, 2);
});

test('missing scan, unfinished scan and failed statuses produce specific warnings', async () => {
  for (const [runs, key, text] of [
    [[], 'overdue-2026-10-28', 'No scheduled run was found'],
    [[run({ status: 'in_progress', conclusion: null })], 'overdue-2026-10-28', 'has not finished'],
    [[run({ conclusion: 'failure' })], 'failure-123', 'failure'],
    [[run({ conclusion: 'timed_out' })], 'failure-123', 'timed out'],
    [[run({ conclusion: 'cancelled' })], 'failure-123', 'cancelled'],
  ]) {
    const f = fixture(runs);
    const result = await monitor(env, {}, now, f.fetch);
    assert.equal(result.name, `security-audit-${key}`);
    assert.equal(result.status, 'sent');
    assert.match(f.messages[0], new RegExp(text));
    assert.doesNotMatch(f.messages[0], /test-token|private upstream|sensitive upstream/);
  }
});

test('unrelated dates, premature and future runs cannot satisfy expected schedule', async () => {
  for (const created_at of ['2026-10-27T06:30:00Z', '2026-10-28T06:14:00Z', '2026-10-28T09:00:00Z']) {
    const f = fixture([run({ created_at })]);
    assert.match((await monitor(env, {}, now, f.fetch)).name, /overdue/);
  }
  const f = fixture([run()]);
  assert.match((await monitor(env, {}, new Date('2026-10-28T07:00:00Z'), f.fetch)).name, /overdue-2026-10-27/);
});

test('manual scans cannot conceal a missing schedule, even if API ignores the filter', async () => {
  const f = fixture([run({ event: 'workflow_dispatch' })]);
  assert.equal((await monitor(env, {}, now, f.fetch)).health, 'unknown');
  assert.match(f.messages[0], /health is unknown/);
});

test('latest scheduled run determines recovery regardless of API order', async () => {
  for (const runs of [
    [run({ conclusion: 'failure' }), run({ id: 124, created_at: '2026-10-28T07:00:00Z' })],
    [run({ id: 124, created_at: '2026-10-28T07:00:00Z' }), run({ conclusion: 'failure' })],
  ]) assert.equal(await inspectAudit(env, {}, now, fixture(runs).fetch), null);
});

test('event notifications re-read the run to suppress recovered or running reruns', async () => {
  const event = { action: 'completed', workflow_run: run({ conclusion: 'failure' }) };
  for (const current of [run(), run({ status: 'in_progress', conclusion: null })]) {
    const f = fixture([], { current });
    assert.equal((await monitor({ ...env, GITHUB_EVENT_NAME: 'workflow_run' }, event, now, f.fetch)).status, 'healthy');
    assert.equal(f.calls.length, current.status === 'completed' ? 2 : 1);
  }
});

test('manual failed runs notify too and share the incident key with hourly checks', async () => {
  const current = run({ event: 'workflow_dispatch', conclusion: 'failure' });
  const f = fixture([], { current });
  const result = await monitor({ ...env, GITHUB_EVENT_NAME: 'workflow_run' }, { action: 'completed', workflow_run: current }, now, f.fetch);
  assert.equal(result.name, 'security-audit-failure-123');
  assert.match(f.messages[0], /https:\/\/github.com\/Art-of-Technology\/maestro-desk\/actions\/runs\/123/);
});

test('saved delivery suppresses repeats; a later failed run is a new incident', async () => {
  const f = fixture([run({ conclusion: 'failure' })]);
  const first = await monitor(env, {}, now, f.fetch);
  const repeated = fixture([run({ conclusion: 'failure' })], { cached: [first.name] });
  assert.equal((await monitor(env, {}, now, repeated.fetch)).status, 'already-alerted');
  assert.equal(repeated.messages.length, 0);
  const next = fixture([run({ id: 124, conclusion: 'failure' })], { cached: [first.name] });
  assert.equal((await monitor(env, {}, now, next.fetch)).status, 'sent');
});

test('history errors and malformed or incomplete responses never report healthy', async () => {
  for (const options of [{ historyError: true }, { total: 101 }, { total: -1 }]) {
    const f = fixture([], options);
    const result = await monitor(env, {}, now, f.fetch);
    assert.equal(result.health, 'unknown');
    assert.equal(result.name, 'security-audit-unknown-2026-10-28');
    assert.doesNotMatch(f.messages[0], /private upstream details/);
  }
});

test('invalid run identity, metadata and events cannot produce a trusted scan result', async () => {
  for (const overrides of [
    { id: '../123' }, { name: 'other' }, { path: '.github/workflows/evil.yml' },
    { head_branch: 'feature' }, { head_repository: { full_name: 'fork/repo' } },
    { event: 'pull_request' }, { created_at: 'bad' }, { status: 'bad' }, { conclusion: null }, { conclusion: 'private upstream details' },
  ]) {
    const f = fixture([run(overrides)]);
    assert.equal((await monitor(env, {}, now, f.fetch)).health, 'unknown');
  }
  const f = fixture([], { current: run({ id: 456 }) });
  assert.equal((await monitor({ ...env, GITHUB_EVENT_NAME: 'workflow_run' }, { action: 'completed', workflow_run: run() }, now, f.fetch)).health, 'unknown');
});

test('untrusted execution contexts fail before network access', async () => {
  for (const overrides of [{ GITHUB_REPOSITORY: 'fork/repo' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'pull_request' }, { MONITOR_MODE: 'bad' }]) {
    const f = fixture();
    await assert.rejects(monitor({ ...env, ...overrides }, {}, now, f.fetch), /Untrusted/);
    assert.equal(f.calls.length, 0);
  }
});

test('delivery test requires main dispatch, is labelled and is deduplicated by monitor run ID', async () => {
  const f = fixture();
  const result = await monitor({ ...env, GITHUB_EVENT_NAME: 'workflow_dispatch', MONITOR_MODE: 'test' }, {}, now, f.fetch);
  assert.equal(result.name, 'security-audit-test-800');
  assert.match(f.messages[0], /^TEST: Respovia security scan alerts/);
  assert.match(f.messages[0], /No scan failure is being claimed/);
  assert.equal(f.calls.length, 2);
  for (const overrides of [{ GITHUB_EVENT_NAME: 'schedule' }, { GITHUB_RUN_ID: '../oops' }]) {
    await assert.rejects(monitor({ ...env, GITHUB_EVENT_NAME: 'workflow_dispatch', MONITOR_MODE: 'test', ...overrides }, {}, now, f.fetch), /Invalid test/);
  }
});

test('delivery and deduplication failures cannot produce a saved send result', async () => {
  for (const options of [{ deliveryError: true }, { cacheError: true }]) {
    const f = fixture([], options);
    await assert.rejects(monitor(env, {}, now, f.fetch));
    assert.equal(f.messages.length, options.cacheError ? 0 : 1);
  }
});

test('workflow uses trusted main, serialized checks and only saves confirmed deliveries', () => {
  const workflow = readFileSync(new URL('../.github/workflows/security-audit-alerts.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflows: \[Dependency security audit\]/);
  assert.match(workflow, /cron: '35 \* \* \* \*'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /ref: main\s+persist-credentials: false/);
  assert.match(workflow, /if: steps.check.outputs.cache-key != ''/);
  assert.match(workflow, /VERIFY_ALERT_KEY:/);
  assert.match(workflow, /if: steps.check.outputs.health == 'unknown'/);
  assert.doesNotMatch(workflow, /download-artifact|head_sha|permissions:[\s\S]*actions: write/);
  const audit = readFileSync(new URL('../.github/workflows/dependency-security-audit.yml', import.meta.url), 'utf8');
  assert.match(audit, /name: Dependency security audit/);
  assert.match(audit, /cron: '15 6 \* \* \*'/);
  assert.match(audit, /bun \.\.\/scripts\/dependency-audit-result.mjs/);
  assert.match(audit, /name: Dependency audit found vulnerabilities\s+if: steps.audit.outputs.outcome == 'findings'\s+run: exit 1/);
  assert.match(audit, /name: Dependency audit could not complete/);
  assert.ok(audit.includes("name: 'Dependency audit counts: ${{ steps.audit.outputs.counts }}'"));
  assert.ok(audit.includes("if: steps.audit.outputs.outcome == 'findings' && steps.audit.outputs.counts != ''"));
  assert.match(audit, /failure\(\) && steps.audit.outputs.outcome != 'findings'/);
});

test('verified severity counts appear only with confirmed findings on the current attempt', async () => {
  const summary = { name: 'Dependency audit counts: critical=1 high=2 moderate=3', status: 'completed', conclusion: 'success' };
  for (const eventMode of [false, true]) {
    for (const [marker, expected] of [['Dependency audit found vulnerabilities', true], ['Dependency audit could not complete', false]]) {
      const current = run({ conclusion: 'failure' });
      const jobs = { total_count: 1, jobs: [{ run_id: 123, run_attempt: 2, name: 'Audit current main dependencies', status: 'completed',
        steps: [summary, { name: marker, conclusion: 'failure' }] }] };
      const f = fixture([current], { jobs });
      await monitor({ ...env, GITHUB_EVENT_NAME: eventMode ? 'workflow_run' : 'schedule' }, eventMode ? { action: 'completed', workflow_run: current } : {}, now, f.fetch);
      assert.equal(f.messages[0].includes('Unique advisories: 1 critical, 2 high, 3 moderate.'), expected);
    }
  }
});

test('missing, malformed, duplicate and unsuccessful summaries retain the generic finding alert', async () => {
  const summary = { name: 'Dependency audit counts: critical=0 high=1 moderate=0', status: 'completed', conclusion: 'success' };
  const invalidNames = ['critical=-1 high=2 moderate=0', 'critical=0 high=0 moderate=0', 'critical=01 high=2 moderate=0',
    'critical=1 high=2 moderate=3 trailing', 'critical=1.5 high=2 moderate=0', 'critical=9007199254740992 high=1 moderate=0',
    'critical=9007199254740991 high=1 moderate=0', 'critical=1 high=2', ''];
  for (const summaries of [[], [summary, summary],
    ...invalidNames.map(name => [{ ...summary, name: `Dependency audit counts: ${name}` }]),
    [{ ...summary, conclusion: 'skipped' }], [{ ...summary, status: 'in_progress' }]]) {
    const jobs = { total_count: 1, jobs: [{ run_id: 123, run_attempt: 2, name: 'Audit current main dependencies', status: 'completed',
      steps: [...summaries, { name: 'Dependency audit found vulnerabilities', conclusion: 'failure' }] }] };
    const f = fixture([run({ conclusion: 'failure' })], { jobs });
    await monitor(env, {}, now, f.fetch);
    assert.match(f.messages[0], /found moderate or higher vulnerabilities/);
    assert.doesNotMatch(f.messages[0], /Unique advisories/);
  }
});

test('alerts distinguish confirmed findings from execution failures for the exact run attempt', async () => {
  for (const [name, message] of [
    ['Dependency audit found vulnerabilities', /found moderate or higher vulnerabilities/],
    ['Dependency audit could not complete', /could not complete.*Vulnerability status is unknown/],
  ]) {
    const jobs = { total_count: 1, jobs: [{ run_id: 123, run_attempt: 2, name: 'Audit current main dependencies', status: 'completed', steps: [{ name, conclusion: 'failure' }] }] };
    for (const eventMode of [false, true]) {
      const current = run({ conclusion: 'failure' });
      const f = fixture([current], { jobs });
      await monitor({ ...env, GITHUB_EVENT_NAME: eventMode ? 'workflow_run' : 'schedule' }, eventMode ? { action: 'completed', workflow_run: current } : {}, now, f.fetch);
      assert.match(f.messages[0], message);
      assert.ok(f.calls.some(call => call.url.endsWith('/actions/runs/123/attempts/2/jobs?per_page=100')));
    }
  }
});

test('missing, malformed, conflicting and stale job results keep the outcome unknown', async () => {
  const job = { run_id: 123, run_attempt: 2, name: 'Audit current main dependencies', status: 'completed', steps: [{ name: 'Dependency audit found vulnerabilities', conclusion: 'failure' }] };
  for (const jobs of [null, {}, { total_count: 0, jobs: [] }, { total_count: 2, jobs: [job] },
    ...[{ run_id: 456 }, { run_attempt: 1 }, { name: 'other' }, { status: 'in_progress' }, { steps: null },
      { steps: [{ name: 'Dependency audit found vulnerabilities', conclusion: 'skipped' }] },
      { steps: [...job.steps, { name: 'Dependency audit could not complete', conclusion: 'failure' }] }]
      .map(overrides => ({ total_count: 1, jobs: [{ ...job, ...overrides }] }))]) {
    const f = fixture([run({ conclusion: 'failure' })], { jobs });
    await monitor(env, {}, now, f.fetch);
    assert.match(f.messages[0], /scan outcome is unknown/);
    assert.doesNotMatch(f.messages[0], /found moderate or higher vulnerabilities/);
  }
});

test('confirmed failure recovers once on a later clean scan, including manual scans and successful reruns', async () => {
  for (const eventMode of [false, true]) {
    for (const sameRun of [false, true]) {
      const clean = run({ id: sameRun ? 123 : 124, event: eventMode ? 'workflow_dispatch' : 'schedule' });
      const options = { cached: ['security-audit-failure-123'], current: clean };
      const context = { ...env, GITHUB_EVENT_NAME: eventMode ? 'workflow_run' : 'schedule' };
      const event = eventMode ? { action: 'completed', workflow_run: clean } : {};
      const f = fixture([clean], options);
      const result = await monitor(context, event, now, f.fetch);
      assert.equal(result.name, 'security-audit-recovery-123');
      assert.equal(result.health, 'healthy');
      assert.match(f.messages[0], /scan recovered/);
      assert.match(f.messages[0], new RegExp(`Clean scan: .*runs/${clean.id}`));
      assert.match(f.messages[0], /Daily schedule health is checked separately/);
      const repeat = fixture([clean], { ...options, cached: [...options.cached, result.name] });
      assert.equal((await monitor(context, event, now, repeat.fetch)).status, 'healthy');
      assert.equal(repeat.messages.length, 0);
    }
  }
});

test('later clean scans do not repeat recovery and overdue receipts never justify recovery', async () => {
  for (const cached of [[], ['security-audit-overdue-2026-10-28'], ['security-audit-failure-123', 'security-audit-recovery-123']]) {
    const clean = run({ id: 125 });
    const f = fixture([clean], { cached });
    assert.equal((await monitor(env, {}, now, f.fetch)).status, 'healthy');
    assert.equal(f.messages.length, 0);
  }
  const f = fixture([], { cached: ['security-audit-recovery-123'] });
  assert.match((await monitor(env, {}, now, f.fetch)).name, /overdue/);
});

test('the latest confirmed failure defines the recovery incident', async () => {
  const clean = run({ id: 125 });
  const f = fixture([clean], { failed: run({ id: 124, conclusion: 'failure' }), receipts: {
    total_count: 2, actions_caches: [
      { key: 'security-audit-failure-123', ref: 'refs/heads/main', created_at: '2026-10-28T06:32:00Z' },
      { key: 'security-audit-failure-124', ref: 'refs/heads/main', created_at: '2026-10-28T07:00:00Z' },
    ],
  } });
  assert.equal((await monitor(env, {}, now, f.fetch)).name, 'security-audit-recovery-124');
});

test('stale successes, newer failures and unfinished scans cannot announce recovery', async () => {
  const clean = run({ id: 124 });
  for (const newer of [
    run({ id: 125, conclusion: 'failure', updated_at: '2026-10-28T08:00:00Z' }),
    run({ id: 125, status: 'in_progress', conclusion: null }),
    run({ id: 125, status: 'queued', conclusion: null }),
    run({ id: 125, updated_at: '2026-10-28T08:00:00Z' }),
    { ...clean, run_attempt: 3 }, { ...clean, conclusion: 'failure' },
  ]) {
    const f = fixture([clean], { cached: ['security-audit-failure-123'], recoveryRuns: newer.id === clean.id ? [newer] : [clean, newer] });
    assert.equal((await monitor(env, {}, now, f.fetch)).status, 'healthy');
    assert.equal(f.messages.length, 0);
  }
  const old = run({ id: 124, updated_at: '2026-10-28T06:31:00Z' });
  const f = fixture([old], { cached: ['security-audit-failure-123'] });
  assert.equal((await monitor(env, {}, now, f.fetch)).status, 'healthy');
  assert.equal(f.messages.length, 0);
});

test('unverifiable recovery evidence never announces recovery', async () => {
  const clean = run({ id: 124 });
  for (const overrides of [
    { recoveryTotal: 101 }, { recoveryRuns: [run({ id: 124, updated_at: 'bad' })] },
    { recoveryRuns: [run({ id: 124, head_branch: 'other' })] },
    { failed: run({ id: 999 }) },
    { receipts: { total_count: 101, actions_caches: [] } },
    { receipts: { total_count: 1, actions_caches: [{ key: 'security-audit-failure-123', ref: 'refs/heads/main', created_at: 'bad' }] } },
  ]) {
    const f = fixture([clean], { cached: ['security-audit-failure-123'], ...overrides });
    const result = await monitor(env, {}, now, f.fetch);
    assert.equal(result.health, 'unknown');
    assert.doesNotMatch(f.messages.join(''), /scan recovered/);
  }
});

test('recovery delivery failure cannot produce a saved recovery receipt', async () => {
  const f = fixture([run({ id: 124 })], { cached: ['security-audit-failure-123'], deliveryError: true });
  await assert.rejects(monitor(env, {}, now, f.fetch));
  assert.equal(f.messages.length, 1);
});
