import { beforeEach, expect, mock, test } from 'bun:test';

const actions = {}, changes = {}, events = {}, stored = new Map();
let workspace = 'workspace-a', jwt = 'user-a', requests = [], downloads = [], pending = [];
globalThis.window = {
  isAdmin: () => false, fmtMinutes: n => `${n}m`,
  escHtml: v => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
  addEventListener: (name, fn) => { events[name] = fn; },
};
window.escAttr = window.escHtml;
globalThis.localStorage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
mock.module('../web/js/core/state.js', () => ({ CURRENT_PAGE: 'reports', REPORT_LAYOUT: {}, SESSION: { userId: 'user-a' } }));
mock.module('../web/js/core/router.js', () => ({ renderPage() {} }));
mock.module('../web/js/core/page-tabs.js', () => ({ pageTabs: () => '', INSIGHT_TABS: [] }));
mock.module('../web/js/core/event-delegation.js', () => ({ registerActions: map => Object.assign(actions, map), registerChangeActions: map => Object.assign(changes, map) }));
mock.module('../web/js/core/widget-shell.js', () => ({ registerWidgetCatalog() {}, renderWidgetGrid: (_scope, _id, widgets, _layout, stats) => widgets.map(w => w.render(stats)).join('') }));
mock.module('../web/js/reports/language-detection.js', () => ({ renderLanguageDetectionFailures: () => '' }));
mock.module('../web/js/core/csv.js', () => ({ downloadCSV: (...args) => downloads.push(args) }));
mock.module('../web/js/core/api-client.js', () => ({
  getWorkspaceId: () => workspace, getJwt: () => jwt,
  apiGet: path => { requests.push(path); return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
}));
const { renderReports } = await import('../web/js/reports/index.js');
const { saveStatView } = await import('../web/js/core/stat-view.js');
const fixture = () => ({ period: { range: '30d', start: '2026-09-07T00:00:00.000Z', end: '2026-10-06T12:00:00.000Z' }, report: {
  total: 205, byStatus: { resolved: 205 }, byPriority: { normal: 205 }, byCategory: { Other: 205 }, agents: [{ id: 'a', name: '<Agent>', n: 205 }],
  bySentiment: { positive: 205 }, sentimentScored: 205, csatBuckets: [0, 0, 0, 0, 205], csatCount: 205, avgCSAT: 5,
  slaOk: 205, slaWarn: 0, slaBreach: 0, slaCompliance: 100, resolved: 205, resolutionRate: 100,
  timeTotal: 45, timeBillable: 30, timeAgents: [{ id: 'a', name: '<Agent>', total: 45, billable: 30 }],
  sentimentTrend: [{ start: '2026-09-07', days: 1, counts: { positive: 205 } }],
} });
async function finish(value = fixture()) { pending.shift().resolve(value); await new Promise(resolve => setTimeout(resolve, 0)); }
async function load() { renderReports(); await finish(); return renderReports(); }
beforeEach(() => {
  workspace = 'workspace-a'; jwt = 'user-a'; requests = []; downloads = []; pending = []; stored.clear();
  events['respovia:auth-scope-changed']();
  changes['reports.setTF']({}, { value: '30d' });
});

test('loads full server totals and keeps chart preferences and accessible tables', async () => {
  saveStatView('r-status', 'table', ['bar', 'donut', 'table']);
  expect(renderReports()).toContain('Loading workspace totals');
  expect(requests).toEqual(['/api/v1/reports/insights?range=30d']);
  await finish();
  const html = renderReports();
  expect(html).toContain('205 of 205 tickets rated');
  expect(html).toContain('45m total');
  expect(html).toContain('&lt;Agent&gt;');
  expect(html).not.toContain('<Agent>');
  expect(html).toContain('value="table" selected');
  expect(html).toContain('Recorded SLA compliance');
  expect(html).toContain('Ranges include today and use UTC');
  expect(requests).toHaveLength(1);
});

test('CSV preserves applied dates, numeric minutes and protects spreadsheet formulas', async () => {
  await load();
  const exporting = actions['reports.export']();
  expect(renderReports()).toContain('Exporting…');
  const url = new URL(requests.at(-1), 'https://test.invalid');
  expect(url.searchParams.get('end')).toBe(fixture().period.end);
  expect(url.searchParams.get('export')).toBe('1');
  await finish({ tickets: [{ id: 'I-1', subject: '  =FORMULA()', timeTotal: 45, timeBillable: 30 }] });
  await exporting;
  expect(downloads).toHaveLength(1);
  expect(downloads[0][0]).toContain('Time logged (minutes)');
  expect(downloads[0][1][0][1]).toBe("'  =FORMULA()");
  expect(downloads[0][1][0].slice(-2)).toEqual(['45', '30']);
});

test('late responses cannot cross a workspace, login or filter change', async () => {
  for (const change of [() => { workspace = 'workspace-b'; }, () => { jwt = 'user-b'; }, () => changes['reports.setTF']({}, { value: '7d' })]) {
    events['respovia:auth-scope-changed'](); renderReports(); change(); await finish();
    expect(renderReports()).not.toContain('205 of 205');
    await finish();
  }
  // Even switching away and back to the same identity invalidates the in-flight object.
  events['respovia:auth-scope-changed'](); renderReports();
  jwt = null; events['respovia:auth-scope-changed'](); jwt = 'user-b';
  await finish();
  expect(renderReports()).toContain('Loading workspace totals');
  await finish();
});

test('late exports are dropped after workspace switch, refresh or filter change', async () => {
  for (const change of [() => { workspace = 'workspace-b'; }, () => actions['reports.refresh'](), () => changes['reports.setTF']({}, { value: '7d' })]) {
    events['respovia:auth-scope-changed'](); await load();
    const exporting = actions['reports.export'](); change();
    await finish({ tickets: [] }); await exporting;
  }
  expect(downloads).toHaveLength(0);
});

test('failed loads and oversized exports show errors, support retry and never download partial data', async () => {
  renderReports(); pending.shift().reject(Error('offline')); await new Promise(resolve => setTimeout(resolve, 0));
  expect(renderReports()).toContain('Could not load Reports');
  actions['reports.refresh'](); await load();
  const exporting = actions['reports.export']();
  pending.shift().reject(Object.assign(Error('More than 10,000 tickets match. Choose a shorter date range before exporting.'), { status: 422 }));
  await exporting;
  expect(renderReports()).toContain('More than 10,000 tickets match');
  expect(downloads).toHaveLength(0);
  jwt = null; events['respovia:auth-scope-changed']();
  expect(renderReports()).toContain('Sign in to see workspace Reports');
});
