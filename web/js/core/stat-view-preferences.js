import { SESSION } from './state.js';
import { apiGet, apiPatch, getJwt, getWorkspaceId } from './api-client.js';

const formats = ['table', 'bar', 'donut', 'line'];
const unsaved = new Map();
let active;
const endpoint = '/api/v1/me/stat-views';

export function statPreferenceKey(id) {
  return 'respovia:stat-view:' + JSON.stringify([SESSION?.userId || `demo:${SESSION?.role || ''}:${SESSION?.name || ''}`, getWorkspaceId() || 'demo', id]);
}
function read(key) {
  if (unsaved.has(key)) return unsaved.get(key);
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); unsaved.delete(key); return true; }
  catch { unsaved.set(key, value); return false; }
}
function pendingRecord(key) {
  try {
    const record = JSON.parse(read(key));
    return record && formats.includes(record.value) && typeof record.revision === 'string' ? record : null;
  } catch { return null; }
}
function choice(key) { return pendingRecord(key)?.value ?? read(key); }
function current(state) {
  return active === state && SESSION === state.session && getWorkspaceId() === state.workspace && getJwt() === state.jwt;
}
function notify(state) {
  if (current(state)) window.dispatchEvent(new Event('respovia:stat-views'));
}
export function getStatView(id, choices) {
  const value = choice(statPreferenceKey(id));
  return choices.includes(value) ? value : choices[0];
}

// Called when a selector renders, covering login, refresh, workspace switching
// and platform-admin entry without coupling every authentication path to charts.
export function prepareStatView(id, choices) {
  if (!SESSION?.userId || !getWorkspaceId() || !getJwt()) return null;
  if (!active || !current(active)) {
    active = { session: SESSION, workspace: getWorkspaceId(), jwt: getJwt(), views: new Map(),
      pending: new Map(), jobs: new Set(), changed: new Set(), statuses: new Map(), remote: {}, loaded: false, failed: false };
    void load(active);
  }
  const state = active;
  if (!state.views.has(id)) {
    state.views.set(id, choices);
    const key = statPreferenceKey(id);
    const record = pendingRecord(key);
    if (record && choices.includes(record.value)) {
      state.pending.set(id, record);
      state.changed.add(id);
      void flush(state, id);
    }
    if (state.loaded) reconcile(state, id);
  } else if (state.pending.has(id)) {
    void flush(state, id);
  }
  return state;
}

async function load(state) {
  if (state.loading) return;
  state.loading = true;
  state.failed = false;
  try {
    const result = await apiGet(endpoint, { signal: AbortSignal.timeout(10000) });
    if (!current(state)) return;
    if (!result?.views || typeof result.views !== 'object' || Array.isArray(result.views)) throw Error('Invalid preferences');
    state.remote = result.views;
    state.loaded = true;
    state.failed = false;
    for (const id of state.views.keys()) reconcile(state, id);
  } catch {
    if (current(state)) state.failed = true;
  }
  state.loading = false;
  notify(state);
}

function reconcile(state, id) {
  if (state.changed.has(id) || state.pending.has(id)) return;
  const key = statPreferenceKey(id), choices = state.views.get(id);
  if (pendingRecord(key)) return; // Preserve a newer unsynced choice from another tab.
  if (Object.hasOwn(state.remote, id)) {
    if (choices.includes(state.remote[id])) write(key, state.remote[id]);
  } else {
    const value = read(key);
    if (choices.includes(value)) {
      state.pending.set(id, { value, revision: crypto.randomUUID(), import: true });
      void flush(state, id);
    }
  }
}

export function saveStatView(id, value, choices) {
  if (!choices.includes(value) || !formats.includes(value)) return false;
  const state = prepareStatView(id, choices);
  const key = statPreferenceKey(id);
  if (state) {
    const record = { value, revision: crypto.randomUUID() };
    state.pending.set(id, record);
    state.changed.add(id);
    // Value and pending receipt share one atomic browser write: quota failures
    // cannot leave a cached choice that looks synced and is lost on refresh.
    const saved = write(key, JSON.stringify(record));
    void flush(state, id);
    return saved;
  }
  return write(key, value);
}

async function flush(state, id) {
  if (!current(state) || state.jobs.has(id)) return;
  // Serialize rapid changes to this statistic; updates to other statistics are independent.
  state.jobs.add(id);
  try {
    while (current(state) && state.pending.has(id)) {
      const record = state.pending.get(id), key = statPreferenceKey(id);
      state.statuses.set(id, 'Saving…');
      notify(state);
      try {
        const result = await apiPatch(endpoint, { id, format: record.value, only_if_missing: !!record.import }, { signal: AbortSignal.timeout(10000) });
        if (!current(state)) return;
        if (!state.views.get(id).includes(result?.format)) throw Error('Invalid preference');
        if (state.pending.get(id) !== record) continue;
        state.pending.delete(id);
        state.remote[id] = result.format;
        // Another tab may have queued a newer choice. Never remove its receipt.
        if (record.import ? !pendingRecord(key) : read(key) === JSON.stringify(record)) write(key, result.format);
        state.statuses.set(id, 'Synced');
      } catch {
        if (!current(state)) return;
        if (state.pending.get(id) !== record) continue;
        state.statuses.set(id, unsaved.has(key) ? 'Could not save this view. Keep this page open and retry.' : 'Saved in this browser. Could not sync.');
        break;
      }
    }
  } finally {
    state.jobs.delete(id);
    notify(state);
  }
}

export function statSaveStatus(id) {
  if (!active || !current(active)) return '';
  return active.statuses.get(id) || (active.failed ? 'Could not load saved views. Showing this browser’s choices.' : !active.loaded ? 'Loading saved views…' : '');
}

export function statSaveNeedsRetry(id) {
  return active && current(active) && !active.jobs.has(id) && (active.pending.has(id) || (active.failed && !active.loading && !active.statuses.has(id)));
}

export function retryStatViews() {
  if (!active || !current(active)) return;
  if (active.failed) void load(active);
  for (const id of active.pending.keys()) void flush(active, id);
  notify(active);
}
window.addEventListener?.('online', retryStatViews);
