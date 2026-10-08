import { beforeEach, expect, mock, test } from 'bun:test';

const local = new Map(), server = new Map(), events = new Map();
let workspace, jwt, requests, holdGet, holdPatch, offline;
globalThis.window = { addEventListener: (name, fn) => events.set(name, fn), dispatchEvent() {} };
globalThis.localStorage = { getItem: k => local.get(k) ?? null, setItem: (k, v) => local.set(k, v), removeItem: k => local.delete(k) };
globalThis.sessionStorage = { getItem: k => k === 'maestro_workspace_id' ? workspace : k === 'maestro_jwt' ? jwt : null };
globalThis.fetch = async (_url, options) => {
  const scope = options.headers.Authorization + '/' + options.headers['X-Workspace-Id'];
  const body = options.body && JSON.parse(options.body);
  const request = { scope, body, method: options.method };
  requests.push(request);
  if (offline) throw Error('offline');
  // Capture a GET snapshot now, allowing it to arrive after a later successful save.
  const snapshot = { ...server.get(scope) };
  if ((holdGet && !body) || (holdPatch && body)) await new Promise(resolve => { request.release = resolve; });
  if (!body) return Response.json({ views: snapshot });
  const views = server.get(scope) || {};
  if (!body.only_if_missing || !Object.hasOwn(views, body.id)) views[body.id] = body.format;
  server.set(scope, views);
  return Response.json({ format: views[body.id] });
};
const { setSession } = await import('../web/js/core/state.js');
const prefs = await import('../web/js/core/stat-view-preferences.js');
const choices = ['bar', 'table', 'donut'];
const finish = () => new Promise(resolve => setTimeout(resolve, 5));
const scope = () => 'Bearer ' + jwt + '/' + workspace;
beforeEach(() => {
  local.clear(); server.clear(); requests = [];
  workspace = 'workspace-a'; jwt = 'alice-token'; offline = holdGet = holdPatch = false;
  setSession({ userId: 'alice' });
});

test('saves follow the account to an empty browser, refresh and a new login', async () => {
  prefs.prepareStatView('r-status', choices); await finish();
  prefs.saveStatView('r-status', 'table', choices); await finish();
  expect(prefs.statSaveStatus('r-status')).toBe('Synced');
  expect(local.get(prefs.statPreferenceKey('r-status'))).toBe('table');
  local.clear();
  const device = await import('../web/js/core/stat-view-preferences.js?second-device');
  device.prepareStatView('r-status', choices); await finish();
  expect(device.getStatView('r-status', choices)).toBe('table');
  setSession(null); setSession({ userId: 'alice' });
  device.prepareStatView('r-status', choices); await finish();
  expect(device.getStatView('r-status', choices)).toBe('table');
});

test('browser import fills only missing keys, including a concurrent server save', async () => {
  local.set(prefs.statPreferenceKey('r-status'), 'donut');
  holdPatch = true;
  prefs.prepareStatView('r-status', choices); await finish();
  expect(requests[1].body.only_if_missing).toBe(true);
  server.set(scope(), { 'r-status': 'table', 'r-priority': 'bar' });
  requests[1].release(); await finish();
  expect(prefs.getStatView('r-status', choices)).toBe('table');
  expect(server.get(scope())['r-priority']).toBe('bar');
});

test('existing server choices win over stale browser copies without writing them back', async () => {
  server.set(scope(), { 'r-status': 'table' });
  local.set(prefs.statPreferenceKey('r-status'), 'donut');
  prefs.prepareStatView('r-status', choices); await finish();
  expect(prefs.getStatView('r-status', choices)).toBe('table');
  expect(requests).toHaveLength(1);
});

test('rapid changes serialize per statistic and late hydration cannot undo a save', async () => {
  holdGet = holdPatch = true;
  prefs.prepareStatView('r-status', choices);
  prefs.saveStatView('r-status', 'table', choices);
  prefs.saveStatView('r-status', 'donut', choices);
  expect(requests.filter(r => r.body)).toHaveLength(1);
  requests[1].release(); await finish();
  expect(requests[2].body.format).toBe('donut');
  requests[2].release(); await finish();
  requests[0].release(); await finish();
  expect(prefs.getStatView('r-status', choices)).toBe('donut');
  expect(server.get(scope())['r-status']).toBe('donut');
});

test('failed writes remain local through refresh and retry when online', async () => {
  offline = true;
  prefs.saveStatView('r-status', 'table', choices); await finish();
  expect(prefs.statSaveStatus('r-status')).toContain('Saved in this browser');
  const refreshed = await import('../web/js/core/stat-view-preferences.js?offline-refresh');
  refreshed.prepareStatView('r-status', choices); await finish();
  expect(refreshed.getStatView('r-status', choices)).toBe('table');
  offline = false; events.get('online')(); await finish();
  expect(server.get(scope())['r-status']).toBe('table');
  expect(refreshed.statSaveStatus('r-status')).toBe('Synced');
});

test('delayed loads and queued writes cannot cross account or workspace switches', async () => {
  holdGet = holdPatch = true;
  server.set(scope(), { 'r-status': 'donut' });
  prefs.prepareStatView('r-status', choices);
  prefs.saveStatView('r-priority', 'table', choices);
  prefs.saveStatView('r-priority', 'donut', choices);
  const old = [...requests];
  jwt = 'bob-token'; setSession({ userId: 'bob' });
  workspace = 'workspace-b'; holdGet = holdPatch = false;
  prefs.prepareStatView('r-status', choices); await finish();
  for (const r of old) r.release(); await finish();
  expect(prefs.getStatView('r-status', choices)).toBe('bar');
  expect(requests.filter(r => r.body)).toHaveLength(1);
  expect(requests[1].scope).toBe('Bearer alice-token/workspace-a');
  expect(server.get(scope())).toBeUndefined();
});

test('unavailable storage still saves remotely, and failures do not claim persistence', async () => {
  const original = localStorage.setItem;
  localStorage.setItem = () => { throw Error('blocked'); };
  try {
    prefs.saveStatView('r-status', 'table', choices); await finish();
    expect(prefs.statSaveStatus('r-status')).toBe('Synced');
    expect(server.get(scope())['r-status']).toBe('table');
    offline = true;
    prefs.saveStatView('r-status', 'donut', choices); await finish();
    expect(prefs.statSaveStatus('r-status')).toContain('Keep this page open');
  } finally { localStorage.setItem = original; }
});

test('demo users keep browser-only preferences and invalid formats are rejected', async () => {
  setSession({ name: 'Demo', role: 'Admin' }); jwt = null;
  prefs.saveStatView('r-status', 'table', choices);
  expect(prefs.getStatView('r-status', choices)).toBe('table');
  expect(prefs.saveStatView('r-status', 'line', choices)).toBe(false);
  await finish(); expect(requests).toHaveLength(0);
});

test('changing a failed choice keeps the newest selection visible while the retry is in flight', async () => {
  const handlers = {};
  mock.module('../web/js/core/event-delegation.js', () => ({ registerActions() {}, registerChangeActions: map => Object.assign(handlers, map) }));
  window.escHtml = String; window.escAttr = String;
  await import('../web/js/core/stat-view.js');
  offline = true;
  prefs.saveStatView('r-status', 'table', choices); await finish();
  offline = false; holdPatch = true;
  const panels = choices.map(statFormat => ({ dataset: { statFormat }, hidden: statFormat !== 'table' }));
  const status = {};
  const host = { querySelectorAll: () => panels, querySelector: () => status };
  const el = { value: 'donut', dataset: { statId: 'r-status', statScope: prefs.statPreferenceKey('r-status') }, closest: () => host };
  globalThis.document = { querySelectorAll: () => [el] };
  window.dispatchEvent = event => events.get(event.type)?.();
  try {
    handlers['stat.view'](el.dataset, el);
    expect(el.value).toBe('donut');
    expect(panels.map(p => p.hidden)).toEqual([true, true, false]);
    requests.at(-1).release(); await finish();
    requests.at(-1).release(); await finish();
    expect(el.value).toBe('donut');
    expect(status.innerHTML).toBe('Synced');
  } finally { window.dispatchEvent = () => {}; }
});
