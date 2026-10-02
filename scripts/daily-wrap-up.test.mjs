import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectSources, renderSummary, deliverReport, runReport, safeDiagnostic } from './daily-wrap-up.mjs';
import { validReceipt, github, readState, saveState, initializeState } from './wrap-up-state.mjs';

const start = '2026-10-01T16:30:00.000Z', cutoff = '2026-10-02T16:30:00.000Z';
const receipt = { coverageThrough: start, verifiedAt: start, channelId: 'C0C0W6B9PU6', messageTs: '123.456' };
const makeState = () => ({ sha: 'a'.repeat(40), value: { version: 1, receipt: { ...receipt }, pending: null, lastDate: '2026-10-01', lastTestRun: null } });
const source = { id: 'PR7', title: 'Edit notes', body: 'Admins can correct notes.', url: 'https://github.com/Art-of-Technology/maestro-desk/pull/7' };
const env = { GITHUB_REPOSITORY: 'Art-of-Technology/maestro-desk', GITHUB_REF: 'refs/heads/main', GITHUB_TOKEN: 'fake', GITHUB_RUN_ID: '789' };

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
  assert.match(text, /3 changes merged to main/);
  assert.ok(text.includes(source.url)); assert.ok(text.includes('commit/' + 'a'.repeat(40)));
  assert.ok(text.includes('&lt;!channel&gt;')); assert.ok(!text.includes('evil.invalid'));
  assert.ok(text.includes('Coverage through: ' + cutoff));
  assert.throws(() => renderSummary([source, source], start, cutoff), /Invalid report source/);
  assert.throws(() => renderSummary([{ id: '../bad', title: 'bad' }], start, cutoff), /Invalid report source/);
  assert.match(renderSummary([], start, cutoff), /No new changes merged to main/);
  assert.match(renderSummary([{ ...source, title: 'x'.repeat(300) }], start, cutoff), /…/);
  assert.throws(() => renderSummary(Array.from({length: 100}, (_, n) => ({ id: 'PR' + (n + 1), title: 'x'.repeat(180) })), start, cutoff), /Slack length limit/);
});

test('preview needs only GitHub and no AI key, including when there are merged changes', async () => {
  const result = await runReport({ ...env, REPORT_MODE: 'preview' }, new Date(cutoff), async (url, options) => {
    assert.ok(url.startsWith('https://api.github.com/repos/Art-of-Technology/maestro-desk/'));
    assert.equal(options.method, 'GET');
    if (url.includes('/contents/')) return Response.json({ encoding: 'base64', sha: 'a'.repeat(40), content: Buffer.from(JSON.stringify(makeState().value)).toString('base64') });
    if (url.includes('/pulls?')) return Response.json([{ number: 7, base: { ref: 'main' }, merged_at: cutoff, updated_at: cutoff, title: 'feat: Edit notes' }]);
    if (url.includes('/commits?')) return Response.json([]);
    assert.fail('Unexpected request');
  });
  assert.equal(result.status, 'preview'); assert.match(result.text, /Edit notes/);
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
