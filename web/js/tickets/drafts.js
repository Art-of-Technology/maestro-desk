import { COMPOSE_TAB } from '../core/state.js';
// ─── Composer drafts ─────────────────────────────────────────────────────────
// Persist the composer textarea's content to localStorage per (ticket, tab)
// so an agent can switch tickets mid-draft without losing work. The key
// embeds COMPOSE_TAB so a partial reply and a partial internal note on the
// same ticket coexist independently.
//
// COMPOSE_TAB is imported from core/state.js.

function getDraftKey(id) { return `draft:${id}:${COMPOSE_TAB}`; }

export function loadDraft(id)   { return localStorage.getItem(getDraftKey(id)) || ''; }

export function saveDraft(id, value) {
  if (value && value.length) localStorage.setItem(getDraftKey(id), value);
  else localStorage.removeItem(getDraftKey(id));
}

export function clearDraft(id) { localStorage.removeItem(getDraftKey(id)); }

// Remove EVERY tab's draft for a ticket (reply + internal note) — used when
// the ticket itself is deleted, where clearing only the active COMPOSE_TAB
// would leave the other tab's draft orphaned in localStorage forever.
export function clearAllDrafts(id) {
  const prefix = `draft:${id}:`;
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) localStorage.removeItem(k);
  }
}
