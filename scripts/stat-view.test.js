import { expect, test, mock } from 'bun:test';

const stored = new Map();
const handlers = {};
globalThis.localStorage = { getItem: k => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, v) };
globalThis.sessionStorage = { getItem: key => key === 'maestro_workspace_id' ? 'workspace-a' : null };
globalThis.window = { escHtml: v => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') };
window.escAttr = window.escHtml;
mock.module('../web/js/core/event-delegation.js', () => ({ registerActions() {}, registerChangeActions: map => Object.assign(handlers, map) }));
const { setSession } = await import('../web/js/core/state.js');
const { renderDataChart } = await import('../web/js/core/chart.js');
let views = await import('../web/js/core/stat-view.js');
const choices = ['bar', 'table'];

test('preferences survive module reload and logout/login, independently per user, workspace and statistic', async () => {
  setSession({ userId: 'alice' });
  expect(views.saveStatView('status', 'table', choices)).toBe(true);
  expect(views.getStatView('priority', choices)).toBe('bar');
  setSession(null);
  expect(views.getStatView('status', choices)).toBe('bar');
  setSession({ userId: 'bob' });
  expect(views.getStatView('status', choices)).toBe('bar');
  setSession({ userId: 'alice' });
  sessionStorage.getItem = key => key === 'maestro_workspace_id' ? 'workspace-b' : null;
  expect(views.getStatView('status', choices)).toBe('bar');
  sessionStorage.getItem = key => key === 'maestro_workspace_id' ? 'workspace-a' : null;
  const reloaded = await import('../web/js/core/stat-view.js?reload');
  expect(reloaded.getStatView('status', choices)).toBe('table');
  views = reloaded;
  stored.set(views.statPreferenceKey('status'), 'line');
  expect(views.getStatView('status', choices)).toBe('bar');
  expect(views.saveStatView('status', 'line', choices)).toBe(false);
});

test('all chart formats preserve labelled values and escape labels; zero and single-point data stay finite', () => {
  const headers = ['Date', 'Tickets'];
  const rows = [['<unsafe>', 4], ['2026-10-06', 0]];
  for (const format of ['bar', 'donut', 'line', 'table']) {
    const html = renderDataChart(headers, rows, format);
    expect(html).toContain('&lt;unsafe&gt;');
    expect(html).not.toContain('<unsafe>');
    expect(html).toContain('4');
    expect(html).not.toMatch(/NaN|Infinity/);
    expect(renderDataChart(headers, [['Today', 0]], format)).not.toMatch(/NaN|Infinity/);
    expect(renderDataChart(headers, [], format)).toContain('No data');
  }
  const multi = renderDataChart(['Date', 'Helpful', 'Unhelpful'], [['Today', 3, 2]], 'table');
  expect(multi).toContain('<td>3</td><td>2</td>');
  const sparse = renderDataChart(headers, [['Oct 1', 4], ['Oct 2', 4], ['Oct 6', 4]], 'line', { xValues: [1, 2, 6] });
  expect(sparse).toContain('points="48,25 140,25 508,25"');
  expect(sparse).not.toContain('tabindex="0"');
});

test('view switching preserves the host, rejects stale account controls and reports storage failures', () => {
  setSession({ userId: 'alice' });
  const panels = choices.map(statFormat => ({ dataset: { statFormat }, hidden: statFormat !== 'bar' }));
  const status = { textContent: '' };
  const host = { querySelectorAll: () => panels, querySelector: () => status };
  const el = { value: 'table', closest: () => host };
  const ds = { statId: 'switch', statScope: views.statPreferenceKey('switch') };
  handlers['stat.view'](ds, el);
  expect(panels.map(p => p.hidden)).toEqual([true, false]);
  setSession({ userId: 'bob' }); el.value = 'bar';
  handlers['stat.view'](ds, el);
  expect(panels.map(p => p.hidden)).toEqual([true, false]);
  setSession({ userId: 'alice' });
  const save = localStorage.setItem;
  localStorage.setItem = () => { throw Error('quota'); };
  handlers['stat.view'](ds, el);
  expect(status.textContent).toContain('could not save');
  expect(panels.map(p => p.hidden)).toEqual([false, true]);
  expect(views.getStatView('switch', choices)).toBe('bar');
  localStorage.setItem = save;
});

test('each selector advertises only its supported formats and a specific accessible name', () => {
  const html = views.renderStatView('test', 'Tickets per agent', ['Agent', 'Tickets'], [['Alice', 4]]);
  expect(html).toContain('aria-label="Tickets per agent: view as"');
  expect(html).toContain('value="table"');
  expect(html).not.toContain('value="line"');
  expect(html).not.toContain('value="donut"');
});
