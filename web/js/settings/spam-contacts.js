import { apiGet, apiDelete, getJwt, getWorkspaceId } from '../core/api-client.js';
import { can } from '../core/permissions.js';
import { registerActions } from '../core/event-delegation.js';
import { formatRoute } from '../core/route-location.js';
import { CUSTOMERS } from '../core/data.js';
import { showModal, closeModal } from '../core/modal.js';
import { showToast } from '../core/toast.js';

const states = new WeakMap();
const allowed = () => can('customers.view') && can('customers.spam');
const current = (root, state) => root.isConnected && states.get(root) === state
  && state.workspace === getWorkspaceId() && state.jwt === getJwt() && allowed();
const date = value => value ? new Date(value).toLocaleString('en-GB') : 'Not recorded';
const name = row => [row.first_name, row.last_name].filter(Boolean).join(' ') || row.display_id;

export function settingsSpamContacts() {
  if (!allowed()) return '<p>You do not have access to spam contacts.</p>';
  queueMicrotask(() => {
    const root = document.querySelector('[data-spam-contacts]');
    if (!root || states.has(root)) return;
    const state = { workspace: getWorkspaceId(), jwt: getJwt(), rows: [], q: '', offset: 0, next: null, busy: false };
    states.set(root, state);
    root.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      if (state.busy || state.saving || !current(root, state)) return;
      state.q = root.querySelector('input').value.trim(); state.offset = 0;
      void load(root, state);
    });
    void load(root, state);
  });
  return `<section class="settings-section" data-spam-contacts>
    <h2 class="settings-h">Spam contacts</h2>
    <p class="settings-desc">Future emails from these contacts are closed as spam without a reply or survey. Unmark a contact to allow future emails through. Existing tickets stay unchanged.</p>
    <form class="spam-contact-search"><label for="spam-contact-search">Search by name, email or contact ID</label>
      <div><input class="form-input" id="spam-contact-search" type="search" maxlength="200"><button type="submit" class="btn">Search</button></div></form>
    <div data-spam-list aria-live="polite"></div><div data-spam-history aria-live="polite"></div>
  </section>`;
}

function renderList(root, state) {
  const esc = window.escHtml, attr = window.escAttr;
  root.querySelector('[data-spam-list]').innerHTML = state.error
    ? '<p>Couldn’t load spam contacts.</p><button class="btn" data-action="spamContacts.retry">Try again</button>'
    : `<p>${state.rows.length ? `Showing ${state.offset + 1}–${state.offset + state.rows.length}` : state.q ? 'No matching spam contacts.' : 'No contacts are marked as spam.'}</p>
      ${state.rows.map(row => `<article class="spam-contact-row">
        <div><a class="link" href="${attr(formatRoute({ workspaceId: state.workspace, page: 'customers', entityId: row.id }))}">${esc(name(row))}</a>
          <div>${esc(row.display_id)} · ${esc(row.email || 'No primary email')}</div>
          <div class="spam-contact-meta">Marked: ${esc(date(row.marked_at))} · By: ${esc(row.marked_by || 'Not recorded')}</div></div>
        <div class="spam-contact-actions"><button type="button" class="btn btn-sm" data-action="spamContacts.history" data-id="${attr(row.id)}">View history</button>
          <button type="button" class="btn btn-sm" data-action="spamContacts.unmark" data-id="${attr(row.id)}">Unmark as spam</button></div>
      </article>`).join('')}
      <div class="spam-contact-actions">${state.offset ? '<button class="btn" data-action="spamContacts.previous">Previous</button>' : ''}
      ${state.next != null ? '<button class="btn" data-action="spamContacts.next">Next</button>' : ''}</div>`;
}

async function load(root, state) {
  if (state.busy || !current(root, state)) return;
  state.busy = true; state.error = false;
  const submit = root.querySelector('[type="submit"]'); submit.disabled = true;
  root.querySelector('[data-spam-list]').innerHTML = '<p role="status">Loading spam contacts…</p>';
  try {
    const result = await apiGet(`/api/v1/customers/spam?q=${encodeURIComponent(state.q)}&offset=${state.offset}`);
    if (!current(root, state)) return;
    state.rows = result.contacts; state.next = result.next_offset;
    // An unmark or concurrent change can remove the last row of the last page.
    if (!state.rows.length && state.offset) { state.offset = 0; state.busy = false; return await load(root, state); }
    renderList(root, state);
  } catch {
    if (current(root, state)) { state.error = true; renderList(root, state); }
  } finally { state.busy = false; if (current(root, state)) submit.disabled = false; }
}

async function loadHistory(root, state, more = false) {
  const history = state.history;
  if (!history || history.busy || !current(root, state)) return;
  history.busy = true;
  const slot = root.querySelector('[data-spam-history]');
  slot.innerHTML = '<p role="status">Loading spam history…</p>';
  try {
    const result = await apiGet(`/api/v1/customers/${encodeURIComponent(history.id)}/spam-history?offset=${more ? history.next : 0}`);
    if (!current(root, state) || state.history !== history) return;
    history.events = more ? [...history.events, ...result.events] : result.events;
    history.next = result.next_offset;
    slot.innerHTML = `<h3>Spam history · ${window.escHtml(history.name)}</h3>
      ${history.events.length ? '<ul>' + history.events.map(e => `<li>${e.action === 'customer.spam_marked' ? 'Marked as spam' : 'Unmarked as spam'} · ${window.escHtml(date(e.created_at))} · ${window.escHtml(e.actor)}</li>`).join('') + '</ul>' : '<p>No marking or unmarking history recorded.</p>'}
      ${history.next != null ? '<button class="btn" data-action="spamContacts.moreHistory">Load more history</button>' : ''}`;
  } catch {
    if (current(root, state) && state.history === history) slot.innerHTML = '<p>Couldn’t load spam history.</p><button class="btn" data-action="spamContacts.retryHistory">Try again</button>';
  } finally { history.busy = false; }
}

registerActions({
  'spamContacts.retry': (_ds, el) => { const root = el.closest('[data-spam-contacts]'); return load(root, states.get(root)); },
  'spamContacts.previous': (_ds, el) => { const root = el.closest('[data-spam-contacts]'), state = states.get(root); if (state.busy || state.saving) return; state.offset = Math.max(0, state.offset - 50); return load(root, state); },
  'spamContacts.next': (_ds, el) => { const root = el.closest('[data-spam-contacts]'), state = states.get(root); if (state.busy || state.saving || state.next == null) return; state.offset = state.next; return load(root, state); },
  'spamContacts.history': (ds, el) => {
    const root = el.closest('[data-spam-contacts]'), state = states.get(root), row = state.rows.find(c => c.id === ds.id);
    if (!row || !current(root, state)) return;
    state.history = { id: row.id, name: name(row), events: [], next: null, busy: false };
    return loadHistory(root, state);
  },
  'spamContacts.moreHistory': (_ds, el) => { const root = el.closest('[data-spam-contacts]'); return loadHistory(root, states.get(root), true); },
  'spamContacts.retryHistory': (_ds, el) => { const root = el.closest('[data-spam-contacts]'); return loadHistory(root, states.get(root)); },
  'spamContacts.unmark': (ds, el) => {
    const root = el.closest('[data-spam-contacts]'), state = states.get(root), row = state.rows.find(c => c.id === ds.id);
    if (!row || state.saving || !current(root, state)) return;
    let pending = false;
    showModal('Unmark contact as spam', `<p>Allow future emails from <strong>${window.escHtml(name(row))}</strong> through? Existing tickets stay unchanged.</p><p role="status" id="spam-unmark-result"></p>`, async () => {
      const result = document.getElementById('spam-unmark-result');
      if (pending || !result || !current(root, state)) return;
      if (state.busy) { result.textContent = 'Wait for the contact list to finish loading, then try again.'; return; }
      pending = true; state.saving = true;
      const button = result.closest('.modal').querySelector('[data-action="modal.confirm"]'); button.disabled = true;
      try {
        await apiDelete(`/api/v1/customers/${encodeURIComponent(row.id)}/spam`);
        if (!current(root, state)) return;
        const cached = CUSTOMERS.find(c => c._uuid === row.id); if (cached) cached.isSpam = false;
        if (result.isConnected) closeModal();
        showToast('Contact unmarked as spam. Future emails will arrive normally.');
        await load(root, state);
        if (state.history?.id === row.id) { state.history = { id: row.id, name: name(row), events: [], next: null, busy: false }; await loadHistory(root, state); }
      } catch (error) {
        if (current(root, state) && result.isConnected) result.textContent = error.message || 'Couldn’t unmark this contact. Try again.';
      } finally { pending = false; state.saving = false; if (button.isConnected) button.disabled = false; }
    }, 'Unmark as spam');
  },
});
