import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectSources, renderSummary as renderAll, deliverReport, runReport, safeDiagnostic } from './daily-wrap-up.mjs';
import { validReceipt, github, readState, saveState, initializeState } from './wrap-up-state.mjs';

const start = '2026-10-01T16:30:00.000Z', cutoff = '2026-10-02T16:30:00.000Z';
const receipt = { coverageThrough: start, verifiedAt: start, channelId: 'C0C0W6B9PU6', messageTs: '123.456' };
const makeState = () => ({ sha: 'a'.repeat(40), value: { version: 1, receipt: { ...receipt }, pending: null, lastDate: '2026-10-01', lastTestRun: null } });
const source = { id: 'PR7', title: 'Edit notes', body: 'Admins can correct notes.', url: 'https://github.com/Art-of-Technology/maestro-desk/pull/7' };
const env = { GITHUB_REPOSITORY: 'Art-of-Technology/maestro-desk', GITHUB_REF: 'refs/heads/main', GITHUB_TOKEN: 'fake', GITHUB_RUN_ID: '789' };
const respovia = { id: 'respovia', name: 'Respovia', repository: env.GITHUB_REPOSITORY, branch: 'main' };
const renderSummary = (sources, start, cutoff) => renderAll([{ ...respovia, sources }], start, cutoff);

test('diagnostics exclude unknown and multiline error text', () => {
  assert.equal(safeDiagnostic(new Error('GitHub request failed (403)')), 'GitHub request failed (403)');
  for (const error of [new Error('secret-value'), new Error('GitHub request failed (403)\nsecret-value'), null]) {
    assert.equal(safeDiagnostic(error), 'Unclassified failure; see the last completed stage');
  }
});

test('sources include merged PRs and direct commits, deduplicate PR commits and exclude post-cutoff merges', async () => {
  const routes = [];
  const sources = await collectSources(async route => {
    routes.push(route);
    if (route.startsWith('pulls?')) return [
      { number: 7, base: { ref: 'main' }, merged_at: cutoff, updated_at: cutoff, title: source.title, body: source.body },
      { number: 8, base: { ref: 'main' }, merged_at: '2026-10-03T10:00:00Z', updated_at: '2026-10-03T10:00:00Z' },
      { number: 9, base: { ref: 'main' }, merged_at: start, updated_at: cutoff },
    ];
    if (route.startsWith('commits?')) return ['b', 'c', 'd'].map(ch => ({ sha: ch.repeat(40), commit: { message: 'fix: direct change', committer: { date: cutoff } } }));
    if (route.includes('b'.repeat(40))) return [{ base: { ref: 'main' }, merged_at: cutoff }];
    if (route.includes('c'.repeat(40))) return [{ base: { ref: 'main' }, merged_at: '2026-10-03T10:00:00Z' }];
    return [];
  }, start, cutoff);
  assert.deepEqual(sources.map(s => s.id), ['PR7', 'd'.repeat(40)]);
  assert.equal(routes.length, 5);
  await assert.rejects(collectSources(async () => ({}), start, cutoff));
  await assert.rejects(collectSources(async () => [], cutoff, start));
});

test('pagination reads the full backlog and refuses its explicit ceiling', async () => {
  let pages = 0;
  const api = async route => {
    if (!route.startsWith('pulls?')) return [];
    pages++;
    if (pages === 2) return [];
    return Array.from({ length: 100 }, (_, n) => ({ number: n + 1, base: { ref: 'main' }, updated_at: cutoff, merged_at: cutoff, title: 'Maintenance' }));
  };
  assert.equal((await collectSources(api, start, cutoff)).length, 100);
  assert.equal(pages, 2);
  await assert.rejects(collectSources(async () => Array.from({ length: 100 }, (_, n) => ({ number: n + 1, base: { ref: 'main' }, updated_at: cutoff })), start, cutoff), /safe limit/);
});

test('report preserves every change, classifies explicit prefixes, escapes mentions and pins links', () => {
  const text = renderSummary([
    { ...source, title: 'feat(notes): Edit notes' },
    { id: 'PR8', title: 'fix!: Restore drafts' },
    { id: 'a'.repeat(40), title: 'Maintenance <!channel>', url: 'https://evil.invalid' },
  ], start, cutoff);
  assert.match(text, /New features/); assert.match(text, /Fixes/); assert.match(text, /Other changes/);
  assert.match(text, /3 updates across 1 projects/);
  assert.ok(text.includes(source.url)); assert.ok(text.includes('commit/' + 'a'.repeat(40)));
  assert.ok(text.includes('&lt;!channel&gt;')); assert.ok(!text.includes('evil.invalid'));
  assert.ok(text.includes('Coverage through: ' + cutoff));
  assert.throws(() => renderSummary([source, source], start, cutoff), /Invalid report source/);
  assert.throws(() => renderSummary([{ id: '../bad', title: 'bad' }], start, cutoff), /Invalid report source/);
  assert.match(renderSummary([], start, cutoff), /No new changes/);
  assert.match(renderSummary([{ ...source, title: 'x'.repeat(300) }], start, cutoff), /…/);
  assert.throws(() => renderSummary(Array.from({length: 100}, (_, n) => ({ id: 'PR' + (n + 1), title: 'x'.repeat(180) })), start, cutoff), /Slack length limit/);
});

test('preview needs only GitHub and no AI key, including when there are merged changes', async () => {
  const result = await runReport({ ...env, REPORT_MODE: 'preview' }, new Date(cutoff), async (url, options) => {
    assert.match(url, /^https:\/\/api\.github\.com\/repos\/Art-of-Technology\/maestro-desk(?:\/|$)/);
    assert.equal(options.method, 'GET');
    if (url.endsWith('/maestro-desk')) return Response.json({ default_branch: 'main' });
    if (url.includes('/contents/')) return Response.json({ encoding: 'base64', sha: 'a'.repeat(40), content: Buffer.from(JSON.stringify(makeState().value)).toString('base64') });
    if (url.includes('/pulls?')) return Response.json([{ number: 7, base: { ref: 'main' }, merged_at: cutoff, updated_at: cutoff, title: 'feat: Edit notes' }]);
    if (url.includes('/commits?')) return Response.json([]);
    assert.fail('Unexpected request');
  });
  assert.equal(result.status, 'preview'); assert.match(result.text, /Edit notes/);
  assert.match(result.text, /\*Respovia\*/); assert.match(result.text, /\*Orbit\*/);
  assert.match(result.text, /Local updates unavailable/);
});

test('confirmed delivery advances coverage once; test deliveries leave coverage alone', async () => {
  const state = makeState(), saved = [];
  let sends = 0;
  const save = async s => saved.push(structuredClone(s.value));
  const send = async () => { sends++; assert.equal(saved.at(-1).pending.cutoff, cutoff); };
  assert.equal(await deliverReport(state, 'text', cutoff, 'send', '789', save, send, () => new Date(cutoff)), 'posted');
  assert.equal(state.value.receipt.coverageThrough, cutoff);
  assert.equal(validReceipt(state.value.receipt, Date.parse(cutoff)), true);
  assert.equal(saved[0].receipt.coverageThrough, start);
  assert.equal(saved[1].pending, null);
  assert.equal(await deliverReport(state, 'text', cutoff, 'send', '790', save, send), 'already-posted');
  assert.equal(sends, 1);
  const trial = makeState();
  await deliverReport(trial, 'text', cutoff, 'test', '800', async () => {}, async text => assert.match(text, /^TEST/));
  assert.equal(trial.value.receipt.coverageThrough, start);
  assert.equal(await deliverReport(trial, 'text', cutoff, 'test', '800', save, send), 'already-posted');
});

test('intent-save failure, Slack timeout and final-save failure never permit a blind retry', async () => {
  let sent = 0;
  await assert.rejects(deliverReport(makeState(), 'text', cutoff, 'send', '789', async () => { throw new Error('conflict'); }, async () => { sent++; }));
  assert.equal(sent, 0);
  for (const failAt of ['slack', 'final-save']) {
    const state = makeState(); let durable = structuredClone(state), saves = 0;
    const save = async s => { if (++saves === 2 && failAt === 'final-save') throw new Error('network'); durable = structuredClone(s); };
    await assert.rejects(deliverReport(state, 'text', cutoff, 'send', '789', save, async () => { if (failAt === 'slack') throw new Error('timeout'); }));
    assert.equal(durable.value.receipt.coverageThrough, start);
    assert.ok(durable.value.pending);
    await assert.rejects(deliverReport(durable, 'text', cutoff, 'send', '789', save, async () => { sent++; }), /uncertain/);
  }
  assert.equal(sent, 0);
});

test('state persistence uses a dedicated branch and compare-and-swap, rejecting corrupt receipts', async () => {
  const state = makeState();
  await saveState(async (route, method, body) => {
    assert.equal(route, 'contents/wrap-up-state.json'); assert.equal(method, 'PUT');
    assert.equal(body.branch, 'codex-wrap-up-state'); assert.equal(body.sha, 'a'.repeat(40));
    return { content: { sha: 'b'.repeat(40) } };
  }, state);
  assert.equal(state.sha, 'b'.repeat(40));
  const read = value => async route => {
    assert.match(route, /ref=codex-wrap-up-state/);
    return { encoding: 'base64', sha: state.sha, content: Buffer.from(JSON.stringify(value)).toString('base64') };
  };
  assert.deepEqual((await readState(read(state.value), Date.parse(cutoff))).value, state.value);
  await assert.rejects(readState(read({ ...state.value, receipt: null }), Date.parse(cutoff)));
  assert.deepEqual((await initializeState(read(state.value), receipt, Date.parse(cutoff))).value, state.value);
  await assert.rejects(github('token', async () => new Response('sensitive', { status: 403 }))('test'), /403/);
});

test('scheduled sending is disabled until cutover and respects weekdays and the UK window', async () => {
  const offline = async () => { throw new Error('Must not contact any service'); };
  assert.equal((await runReport(env, new Date(cutoff), offline)).status, 'disabled');
  assert.equal((await runReport({ ...env, HOSTED_WRAP_UP_ENABLED: 'true' }, new Date('2026-10-02T08:00:00Z'), offline)).status, 'outside-window');
  assert.equal((await runReport({ ...env, HOSTED_WRAP_UP_ENABLED: 'true' }, new Date('2026-10-03T17:30:00Z'), offline)).status, 'outside-window');
  await assert.rejects(runReport({ ...env, GITHUB_REF: 'refs/heads/other' }, new Date(cutoff), offline));
});

test('first initialization creates the state branch and seeds only confirmed coverage', async () => {
  const calls = [];
  const state = await initializeState(async (route, method = 'GET', body) => {
    calls.push({ route, method, body });
    if (route.includes('?ref=') || route === 'git/ref/heads/codex-wrap-up-state') throw Object.assign(new Error('missing'), { status: 404 });
    if (route === 'git/ref/heads/main') return { object: { sha: 'a'.repeat(40) } };
    if (route === 'git/refs') return {};
    return { content: { sha: 'b'.repeat(40) } };
  }, receipt, Date.parse(cutoff));
  assert.equal(calls[3].body.ref, 'refs/heads/codex-wrap-up-state');
  assert.equal(calls[4].body.sha, undefined);
  assert.equal(state.value.lastDate, '2026-10-01');
  assert.deepEqual(state.value.receipt, receipt);
  assert.equal(state.value.pending, null);
});

const localEntry = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', project: 'orbit', completedAt: '2026-10-02T15:00:00.000Z', title: 'feat: Save report filters' };
const activity = { version: 1, since: start, through: '2026-10-02T16:00:00.000Z', entries: [localEntry] };

test('each project has its own heading, repository links and source identifiers', () => {
  const text = renderAll([
    { ...respovia, sources: [source] },
    { id: 'another', name: 'Another project <!channel>', repository: 'Example/another', branch: 'master', sources: [source] },
    { id: 'orbit', name: 'Orbit', source: 'local', sources: [localEntry], observedThrough: activity.through },
  ], start, cutoff);
  assert.match(text, /\*Respovia\*[\s\S]*\*Another project &lt;!channel&gt;\*[\s\S]*\*Orbit\*/);
  assert.ok(text.includes('Art-of-Technology/maestro-desk/pull/7'));
  assert.ok(text.includes('Example/another/pull/7'));
  assert.match(text, /3 updates across 3 projects/);
  assert.match(text, /newer updates unavailable/);
  assert.throws(() => renderAll([{ ...respovia, sources: [] }, { ...respovia, sources: [] }], start, cutoff), /Invalid report projects/);
});

test('local backlog uses its own coverage, catches up after an offline report and preview writes nothing', async () => {
  const state = makeState();
  // The GitHub report has already covered some of this time; Orbit has not.
  state.value.receipt.coverageThrough = '2026-10-02T14:00:00.000Z';
  state.value.receipt.verifiedAt = state.value.receipt.coverageThrough;
  state.value.lastDate = '2026-10-02';
  state.value.localCoverage = { orbit: start };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push(options.method);
    if (url.includes('/contents/')) return Response.json({ encoding: 'base64', sha: state.sha, content: Buffer.from(JSON.stringify(state.value)).toString('base64') });
    if (url.endsWith('/maestro-desk')) return Response.json({ default_branch: 'main' });
    return Response.json([]);
  };
  const result = await runReport({ ...env, REPORT_MODE: 'preview', LOCAL_PROJECT_ACTIVITY: JSON.stringify(activity) }, new Date(cutoff), fetchImpl);
  assert.match(result.text, /Save report filters/);
  assert.deepEqual(new Set(requests), new Set(['GET']));
  await assert.rejects(runReport({ ...env, REPORT_MODE: 'preview', LOCAL_PROJECT_ACTIVITY: JSON.stringify({ ...activity, since: cutoff }) }, new Date(cutoff), fetchImpl), /Invalid local activity/);
  const gap = { ...activity, since: '2026-10-02T12:00:00.000Z' };
  await assert.rejects(runReport({ ...env, REPORT_MODE: 'preview', LOCAL_PROJECT_ACTIVITY: JSON.stringify(gap) }, new Date(cutoff), fetchImpl), /Incomplete local activity/);
});

test('local coverage advances only after confirmed delivery, never for tests or unavailable updates', async () => {
  const state = makeState(), saved = [];
  const localCoverage = { orbit: activity.through };
  await deliverReport(state, 'text', cutoff, 'send', '789', async s => saved.push(structuredClone(s.value)), async () => {}, () => new Date(cutoff), localCoverage);
  assert.deepEqual(saved[0].pending.localCoverage, localCoverage);
  assert.equal(saved[0].localCoverage, undefined);
  assert.deepEqual(state.value.localCoverage, localCoverage);
  const trial = makeState();
  await deliverReport(trial, 'text', cutoff, 'test', '789', async () => {}, async () => {}, () => new Date(cutoff), localCoverage);
  assert.equal(trial.value.localCoverage, undefined);
  const failed = makeState();
  await assert.rejects(deliverReport(failed, 'text', cutoff, 'send', '789', async () => {}, async () => { throw new Error('timeout'); }, () => new Date(cutoff), localCoverage));
  assert.equal(failed.value.localCoverage, undefined);
  assert.deepEqual(failed.value.pending.localCoverage, localCoverage);
  const offline = makeState(); offline.value.localCoverage = localCoverage;
  await deliverReport(offline, 'text', cutoff, 'send', '789', async () => {}, async () => {}, () => new Date(cutoff));
  assert.deepEqual(offline.value.localCoverage, localCoverage);
});

test('source collection uses each project default branch and API client pins the repository', async () => {
  const routes = [];
  await collectSources(async route => { routes.push(route); return []; }, start, cutoff, 'release/main');
  assert.ok(routes[0].includes('base=release%2Fmain'));
  assert.ok(routes[1].includes('sha=release%2Fmain'));
  await github('token', async url => { assert.equal(url, 'https://api.github.com/repos/Example/another/pulls'); return Response.json([]); }, 'Example/another')('pulls');
  assert.throws(() => github('token', fetch, '../bad'), /Invalid report repository/);
});

test('end-to-end delivery keeps Orbit backlog through an offline day and catches up without replaying GitHub work', async () => {
  let durable = makeState().value;
  const messages = [];
  const fetchImpl = async (url, options) => {
    if (url.startsWith('https://hooks.slack.com/')) { messages.push(JSON.parse(options.body).text); return new Response('ok'); }
    if (url.includes('/contents/')) {
      if (options.method === 'PUT') {
        durable = JSON.parse(Buffer.from(JSON.parse(options.body).content, 'base64').toString('utf8'));
        durable.receipt.verifiedAt = durable.receipt.coverageThrough; // Synthetic delivery clock matches each simulated day.
        return Response.json({ content: { sha: 'b'.repeat(40) } });
      }
      return Response.json({ encoding: 'base64', sha: 'a'.repeat(40), content: Buffer.from(JSON.stringify(durable)).toString('base64') });
    }
    if (url.endsWith('/maestro-desk')) return Response.json({ default_branch: 'main' });
    if (url.includes('/commits?')) assert.ok(url.includes(encodeURIComponent(durable.receipt.coverageThrough)));
    return Response.json([]);
  };
  const sendEnv = { ...env, HOSTED_WRAP_UP_ENABLED: 'true', SLACK_DEPLOY_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X' };
  assert.equal((await runReport({ ...sendEnv, LOCAL_PROJECT_ACTIVITY: JSON.stringify(activity) }, new Date(cutoff), fetchImpl)).status, 'posted');
  assert.equal(durable.localCoverage.orbit, activity.through);
  const second = '2026-10-05T16:30:00.000Z';
  await runReport(sendEnv, new Date(second), fetchImpl);
  assert.equal(durable.localCoverage.orbit, activity.through);
  assert.match(messages[1], /Local updates unavailable/);
  const delayed = { ...localEntry, id: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', completedAt: '2026-10-05T12:00:00.000Z', title: 'fix: Restore shared report filters' };
  const caughtUp = { version: 1, since: activity.through, through: '2026-10-06T16:29:00.000Z', entries: [delayed] };
  await runReport({ ...sendEnv, LOCAL_PROJECT_ACTIVITY: JSON.stringify(caughtUp) }, new Date('2026-10-06T16:30:00.000Z'), fetchImpl);
  assert.match(messages[2], /Restore shared report filters/);
  assert.ok(!messages[2].includes('feat: Save report filters'));
  assert.equal(durable.localCoverage.orbit, caughtUp.through);
});
