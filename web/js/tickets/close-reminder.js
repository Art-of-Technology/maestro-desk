import { SESSION, CURRENT_TICKET } from '../core/state.js';
import { apiGet, apiPut, getWorkspaceId, getJwt } from '../core/api-client.js';
import { showToast } from '../core/toast.js';

const states = new Map();
function keyFor(t) {
  return `close-reminder:v1:${getWorkspaceId() || 'demo'}:${SESSION?.userId || 'demo'}:${t._uuid || t.id}`;
}
function state(t) {
  const key = keyFor(t), jwt = getJwt();
  let s = states.get(key);
  if (!s || s.jwt !== jwt) {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(key)); } catch { /* browser storage unavailable */ }
    const legacy = saved === 1;
    s = { key, jwt, ticket: t, pending: legacy || saved?.pending === true,
      version: Number.isInteger(saved?.version) && saved.version >= 0 ? saved.version : null,
      generation: Number.isInteger(saved?.generation) && saved.generation >= 0 ? saved.generation : null,
      dirty: legacy || saved?.dirty === true, legacy, revision: 0, loaded: false, running: null };
    states.set(key, s);
  }
  s.ticket = t;
  return s;
}
function current(s) { return s.key === keyFor(s.ticket) && s.jwt === getJwt() && states.get(s.key) === s; }
function apiBacked(s) { return s.ticket._uuid && getWorkspaceId() && s.jwt && SESSION?.userId; }
function container(t) {
  const el = document.getElementById('ticket-close-reminder');
  return el?.dataset.ticketId === t.id ? el : null;
}
function paint(s) { const el = container(s.ticket); if (current(s) && el) el.innerHTML = closeReminder(s.ticket); }
function save(s) {
  try {
    if (!s.pending && !s.dirty && !s.version && !s.generation) localStorage.removeItem(s.key);
    else localStorage.setItem(s.key, JSON.stringify({ pending: s.pending, version: s.version, generation: s.generation, dirty: s.dirty }));
  } catch { if (s.pending || s.dirty) showToast('This browser could not save the reminder locally. Keep the ticket open until reminder sync finishes.', 'warn', 10000); }
}
function readResponse(response) {
  const r = response?.reminder;
  if (typeof r?.pending !== 'boolean' || !Number.isInteger(r.version) || r.version < 0 || !Number.isInteger(r.generation) || r.generation < 0) throw Error('Invalid reminder response');
  return r;
}
function adopt(s, remote) {
  s.pending = remote.pending; s.version = remote.version; s.generation = remote.generation; s.dirty = false; s.legacy = false;
  save(s); paint(s);
}
export function loadCloseReminder(t, { force = false } = {}) {
  const s = state(t);
  if (!apiBacked(s) || (!force && s.loaded && !s.dirty)) return Promise.resolve();
  if (s.running) return s.running;
  s.running = (async () => {
    try {
      do {
        const remote = readResponse(await apiGet(`/api/v1/tickets/${t._uuid}/close-reminder`, { signal: AbortSignal.timeout(8000) }));
        if (!current(s)) return;
        s.loaded = true;
        if (!s.dirty || (s.legacy && (remote.version > 0 || remote.generation > 0))) { adopt(s, remote); return; }
        // A cleared server version wins over an old offline edit or legacy import.
        if ((s.version !== null && s.version !== remote.version) || (s.generation !== null && s.generation !== remote.generation)) { adopt(s, remote); showToast('The reminder changed on another device. The latest version is shown.', 'warn'); return; }
        const revision = s.revision;
        let saved;
        try {
          saved = readResponse(await apiPut(`/api/v1/tickets/${t._uuid}/close-reminder`,
            { pending: s.pending, version: s.version ?? remote.version, generation: s.generation ?? remote.generation }, { signal: AbortSignal.timeout(8000) }));
        } catch (err) {
          if (!current(s)) return;
          if (err.status !== 409) throw err;
          adopt(s, readResponse(err.body));
          showToast('The reminder changed on another device. The latest version is shown.', 'warn'); return;
        }
        if (!current(s)) return;
        s.version = saved.version; s.generation = saved.generation; s.legacy = false;
        if (s.revision === revision) { adopt(s, saved); return; }
        // A dismissal while the save was in flight must follow its acknowledgement.
        save(s);
      } while (s.dirty && current(s));
    } catch {
      if (current(s)) showToast('Could not sync the close reminder. It is kept in this browser. Reopen the ticket when online to try again.', 'warn', 10000);
    } finally { s.running = null; }
  })();
  return s.running;
}
export async function markCloseReminder(t) {
  const s = state(t);
  s.pending = true; s.dirty = true; s.legacy = false; s.revision++;
  save(s); paint(s);
  await loadCloseReminder(t, { force: true });
}
export async function dismissCloseReminder(t) {
  const s = state(t);
  s.pending = false; s.dirty = true; s.legacy = false; s.revision++;
  save(s); paint(s);
  await loadCloseReminder(t, { force: true });
}
// Confirmed closure clears locally; the database clears every agent's reminder atomically.
export function clearCloseReminder(t) {
  const s = state(t);
  s.pending = false; s.dirty = false; s.legacy = false; s.revision++;
  save(s); container(t)?.replaceChildren();
}
export function closeReminder(t) {
  if (t.status === 'closed' || t.mergedInto) { clearCloseReminder(t); return ''; }
  if (!state(t).pending) return '';
  return `<div class="ticket-close-reminder" role="status">
    <p><strong>Email sent; closing wasn’t confirmed.</strong> Check the ticket status, then retry closing only. Your email will not be sent again.</p>
    <div><button type="button" class="btn btn-sm" data-action="td.retryCloseOnly" data-ticket-id="${window.escAttr(t.id)}">Retry close only</button>
    <button type="button" class="btn btn-sm" data-action="td.dismissCloseReminder" data-ticket-id="${window.escAttr(t.id)}">Dismiss reminder</button></div>
  </div>`;
}
window.addEventListener?.('online', () => {
  for (const s of states.values()) if (current(s) && s.ticket.id === CURRENT_TICKET) void loadCloseReminder(s.ticket, { force: true });
});
