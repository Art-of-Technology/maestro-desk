import { SESSION } from './state.js';
import { apiGet, apiPatch, getJwt, getWorkspaceId } from './api-client.js';

const states = new Map(), memory = new Map();
const endpoint = '/api/v1/me/widget-layouts';
export function widgetLayoutKey(scope) {
  return 'respovia:widget-layout:' + JSON.stringify([SESSION?.userId || `demo:${SESSION?.role || ''}:${SESSION?.name || ''}`, getWorkspaceId() || 'demo', scope]);
}
function read(key) {
  try { return JSON.parse(memory.get(key) ?? localStorage.getItem(key)); } catch { return null; }
}
function write(key, value) {
  const raw = JSON.stringify(value);
  try { localStorage.setItem(key, raw); memory.delete(key); return true; }
  catch { memory.set(key, raw); return false; }
}
function valid(layout) {
  return layout && typeof layout === 'object' && ['order', 'hidden'].every(k =>
    Array.isArray(layout[k]) && layout[k].length <= 50 && layout[k].every(id => typeof id === 'string' && id.length <= 64));
}
export function normalizeWidgetLayout(layout, fallback) {
  const ids = fallback.order;
  const order = valid(layout) ? [...new Set(layout.order)].filter(id => ids.includes(id)) : [...ids];
  return { order: [...order, ...ids.filter(id => !order.includes(id))],
    hidden: valid(layout) ? [...new Set(layout.hidden)].filter(id => ids.includes(id)) : [...fallback.hidden] };
}
export function browserWidgetLayout(scope, fallback) {
  // These old keys have no owner. Only an explicit import may assign them.
  const legacy = read(scope === 'dash' ? 'dash_layout' : 'report_layout');
  return valid(legacy) ? normalizeWidgetLayout(legacy, fallback) : null;
}
function current(state) {
  return states.get(state.scope) === state && state.session === SESSION && state.workspace === getWorkspaceId() && state.jwt === getJwt();
}
function notify(state, changed = false) {
  if (current(state)) window.dispatchEvent(new CustomEvent('respovia:widget-layout', { detail: { scope: state.scope, stamp: state.stamp, changed } }));
}
export function getWidgetLayout(scope, fallback) {
  let state = states.get(scope);
  if (state && current(state)) return state;
  const key = widgetLayoutKey(scope), stored = read(key);
  const pending = valid(stored?.layout) && typeof stored?.revision === 'string' ? stored : null;
  state = { scope, key, fallback, session: SESSION, workspace: getWorkspaceId(), jwt: getJwt(), stamp: crypto.randomUUID(),
    connected: !!(SESSION?.userId && getWorkspaceId() && getJwt()), layout: normalizeWidgetLayout(stored?.layout, fallback),
    pending, edited: !!pending, loading: false, busy: false, failed: false, status: '' };
  states.set(scope, state);
  if (state.connected) {
    void load(state);
    if (state.pending) void flush(state);
  }
  return state;
}
async function load(state) {
  if (!current(state) || state.loading) return;
  state.loading = true;
  state.failed = false;
  if (!state.pending) state.status = 'Loading saved layout…';
  notify(state);
  let changed = false;
  try {
    const result = await apiGet(`${endpoint}/${state.scope}`, { signal: AbortSignal.timeout(10000) });
    if (!current(state)) return;
    if (result?.layout !== null && !valid(result?.layout)) throw Error('Invalid layout');
    if (!state.edited && !state.pending) {
      // Preserve a newer pending edit in another tab, too.
      const stored = read(state.key);
      if (!stored?.revision) {
        const layout = normalizeWidgetLayout(result.layout, state.fallback);
        changed = JSON.stringify(state.layout) !== JSON.stringify(layout);
        state.layout = layout;
        write(state.key, { layout });
      }
      state.status = '';
    }
  } catch {
    if (current(state) && !state.pending && !state.edited) {
      state.failed = true;
      state.status = 'Could not load your saved layout. Showing this browser’s copy or the default layout.';
    }
  } finally {
    state.loading = false;
    notify(state, changed);
  }
}
export function saveWidgetLayout(state, layout) {
  if (!current(state)) return false;
  state.layout = normalizeWidgetLayout(layout, state.fallback);
  state.edited = true;
  state.failed = false;
  const record = state.connected ? { layout: state.layout, revision: crypto.randomUUID() } : { layout: state.layout };
  const saved = write(state.key, record);
  if (state.connected) {
    state.pending = record;
    state.status = 'Saving layout…';
    void flush(state);
  } else {
    state.status = saved ? 'Saved in this browser.' : 'Could not save this layout. Keep this page open.';
    notify(state);
  }
  return saved;
}
async function flush(state) {
  if (!current(state) || state.busy) return;
  state.busy = true;
  try {
    while (current(state) && state.pending) {
      const record = state.pending;
      state.status = 'Saving layout…';
      notify(state);
      try {
        const response = await apiPatch(endpoint, { scope: state.scope, layout: normalizeWidgetLayout(record.layout, state.fallback) }, { signal: AbortSignal.timeout(10000) });
        if (!current(state)) return;
        if (!valid(response?.layout)) throw Error('Invalid layout');
        if (state.pending !== record) continue;
        state.pending = null;
        state.failed = false;
        // Never acknowledge another tab's newer pending edit.
        if (read(state.key)?.revision === record.revision) write(state.key, { layout: state.layout });
        state.status = 'Layout synced';
      } catch (error) {
        if (!current(state)) return;
        if (state.pending !== record) continue;
        state.status = memory.has(state.key) ? 'Could not save this layout. Keep this page open and retry.'
          : error.status === 400 ? 'Saved in this browser. The server could not accept this layout. Refresh to update the available widgets, then retry.'
          : 'Saved in this browser. Could not sync the layout.';
        state.failed = true;
        break;
      }
    }
  } finally { state.busy = false; notify(state); }
}
export function retryWidgetLayout(state) {
  if (!current(state) || !state.connected) return;
  if (state.pending) void flush(state);
  else if (state.failed) void load(state);
}
window.addEventListener?.('online', () => {
  for (const state of states.values()) if (current(state) && state.failed) retryWidgetLayout(state);
});
