import { beforeEach, expect, test } from 'bun:test';

const local = new Map(), server = new Map();
let workspace, jwt, requests, offline, holdGet, holdPatch, events, prefs, moduleId = 0;
globalThis.window = { addEventListener: (name, fn) => events.set(name, fn), dispatchEvent() {} };
globalThis.localStorage = { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value) };
globalThis.sessionStorage = { getItem: key => key === 'maestro_workspace_id' ? workspace : key === 'maestro_jwt' ? jwt : null };
globalThis.fetch = async (url, options) => {
  const owner = options.headers.Authorization + '/' + options.headers['X-Workspace-Id'];
  const body = options.body && JSON.parse(options.body);
  const scope = body?.scope || url.split('/').at(-1);
  const request = { owner, scope, body }; requests.push(request);
  if (offline) throw Error('offline');
  const snapshot = structuredClone(server.get(owner)?.[scope] ?? null);
  if ((body && holdPatch) || (!body && holdGet)) await new Promise((resolve, reject) => { request.release = resolve; request.reject = reject; });
  if (!body) return Response.json({ layout: snapshot });
  const layouts = server.get(owner) || {};
  layouts[scope] = structuredClone(body.layout); server.set(owner, layouts);
  return Response.json({ layout: body.layout });
};
const { setSession } = await import('../web/js/core/state.js');
const fallback = { order: ['status', 'priority', 'volume'], hidden: [] };
const arranged = { order: ['volume', 'status', 'priority'], hidden: ['priority'] };
const owner = () => 'Bearer ' + jwt + '/' + workspace;
const finish = () => new Promise(resolve => setTimeout(resolve, 5));
const freshModule = () => import('../web/js/core/widget-layout-preferences.js?device=' + ++moduleId);
beforeEach(async () => {
  local.clear(); server.clear(); events = new Map(); requests = [];
  offline = holdGet = holdPatch = false; workspace = 'workspace-a'; jwt = 'alice-token'; setSession({ userId: 'alice' });
  prefs = await freshModule();
});

test('normalization removes duplicates and retired widgets, appends new widgets and never mutates defaults', () => {
  expect(prefs.normalizeWidgetLayout({ order: ['volume', 'volume', 'retired'], hidden: ['priority', 'priority', 'retired'] }, fallback)).toEqual(arranged);
  const clean = prefs.normalizeWidgetLayout({ order: 'bad', hidden: [] }, fallback);
  clean.order.reverse(); clean.hidden.push('status');
  expect(fallback).toEqual({ order: ['status', 'priority', 'volume'], hidden: [] });
});
test('legacy browser layout requires explicit import and cannot silently replace the server layout', async () => {
  local.set('dash_layout', JSON.stringify(arranged));
  server.set(owner(), { dash: fallback });
  const state = prefs.getWidgetLayout('dash', fallback); await finish();
  expect(state.layout).toEqual(fallback);
  expect(requests.filter(r => r.body)).toHaveLength(0);
  prefs.saveWidgetLayout(state, prefs.browserWidgetLayout('dash', fallback)); await finish();
  expect(server.get(owner()).dash).toEqual(arranged);
  expect(local.has('dash_layout')).toBe(true);
});
test('order and hidden widgets follow the account into an empty browser and survive a new login', async () => {
  const state = prefs.getWidgetLayout('dash', fallback); await finish();
  prefs.saveWidgetLayout(state, arranged); await finish();
  expect(state.status).toBe('Layout synced');
  local.clear(); const otherDevice = await freshModule();
  const restored = otherDevice.getWidgetLayout('dash', fallback); await finish();
  expect(restored.layout).toEqual(arranged);
  setSession(null); setSession({ userId: 'alice' });
  const signedIn = otherDevice.getWidgetLayout('dash', fallback); await finish();
  expect(signedIn.layout).toEqual(arranged);
});
test('pending offline layouts survive refresh and retry on reconnect without losing to a stale GET', async () => {
  offline = true;
  const state = prefs.getWidgetLayout('dash', fallback);
  prefs.saveWidgetLayout(state, arranged); await finish();
  expect(state.status).toContain('Saved in this browser');
  prefs = await freshModule();
  const restored = prefs.getWidgetLayout('dash', fallback); await finish();
  expect(restored.layout).toEqual(arranged);
  offline = false; events.get('online')(); await finish();
  expect(server.get(owner()).dash).toEqual(arranged);
  expect(restored.status).toBe('Layout synced');
  expect(restored.failed).toBe(false);
});
test('a late failed load cannot mark a successful edit as failed', async () => {
  holdGet = true;
  const state = prefs.getWidgetLayout('dash', fallback);
  prefs.saveWidgetLayout(state, arranged); await finish();
  requests.find(r => !r.body).reject(Error('load failed')); await finish();
  expect(state.status).toBe('Layout synced');
  expect(state.failed).toBe(false);
});
test('a restored pending save beats a GET snapshot taken before the save', async () => {
  offline = true;
  prefs.saveWidgetLayout(prefs.getWidgetLayout('dash', fallback), arranged); await finish();
  prefs = await freshModule(); offline = false; holdGet = true;
  const restored = prefs.getWidgetLayout('dash', fallback); await finish();
  requests.findLast(r => !r.body).release(); await finish();
  expect(restored.layout).toEqual(arranged);
});
test('rapid changes serialize within a page and saves to the other page are independent', async () => {
  holdGet = holdPatch = true;
  const dash = prefs.getWidgetLayout('dash', fallback), report = prefs.getWidgetLayout('report', fallback);
  prefs.saveWidgetLayout(dash, arranged);
  prefs.saveWidgetLayout(dash, { ...arranged, hidden: ['status'] });
  prefs.saveWidgetLayout(report, arranged);
  expect(requests.filter(r => r.body)).toHaveLength(2);
  requests.filter(r => r.body).forEach(r => r.release()); await finish();
  expect(requests.filter(r => r.body)).toHaveLength(3);
  requests.at(-1).release(); await finish();
  requests.filter(r => !r.body).forEach(r => r.release()); await finish();
  expect(dash.layout.hidden).toEqual(['status']);
  expect(server.get(owner()).dash.hidden).toEqual(['status']);
  expect(server.get(owner()).report).toEqual(arranged);
});
test('late loads, queued writes and stale controls cannot cross account or workspace switches', async () => {
  holdGet = holdPatch = true;
  server.set(owner(), { dash: arranged });
  const old = prefs.getWidgetLayout('dash', fallback);
  prefs.saveWidgetLayout(old, arranged);
  prefs.saveWidgetLayout(old, fallback);
  const held = [...requests];
  jwt = 'bob-token'; workspace = 'workspace-b'; setSession({ userId: 'bob' }); holdGet = holdPatch = false;
  const current = prefs.getWidgetLayout('dash', fallback); await finish();
  expect(prefs.saveWidgetLayout(old, arranged)).toBe(false);
  held.forEach(r => r.release()); await finish();
  expect(current.layout).toEqual(fallback);
  expect(requests.filter(r => r.body)).toHaveLength(1);
  expect(requests.find(r => r.body).owner).toBe('Bearer alice-token/workspace-a');
  expect(server.get(owner())).toBeUndefined();
});
test('an unavailable server load can be retried without persisting defaults', async () => {
  server.set(owner(), { dash: arranged }); offline = true;
  const state = prefs.getWidgetLayout('dash', fallback); await finish();
  expect(state.failed).toBe(true);
  offline = false; prefs.retryWidgetLayout(state); await finish();
  expect(state.layout).toEqual(arranged);
  expect(requests.every(r => !r.body)).toBe(true);
});
test('blocked storage does not prevent server saves, and dual failure is explicit', async () => {
  const original = localStorage.setItem;
  localStorage.setItem = () => { throw Error('quota'); };
  try {
    const state = prefs.getWidgetLayout('dash', fallback); await finish();
    prefs.saveWidgetLayout(state, arranged); await finish();
    expect(state.status).toBe('Layout synced');
    offline = true; prefs.saveWidgetLayout(state, fallback); await finish();
    expect(state.status).toContain('Keep this page open');
  } finally { localStorage.setItem = original; }
});
test('demo layouts stay local and scoped separately from connected accounts', async () => {
  jwt = null; setSession({ name: 'Demo', role: 'Admin' });
  const state = prefs.getWidgetLayout('dash', fallback);
  prefs.saveWidgetLayout(state, arranged); await finish();
  expect(state.status).toBe('Saved in this browser.');
  expect(requests).toHaveLength(0);
  setSession({ userId: 'alice' }); jwt = 'alice-token';
  expect(prefs.getWidgetLayout('dash', fallback).layout).toEqual(fallback); await finish();
});
