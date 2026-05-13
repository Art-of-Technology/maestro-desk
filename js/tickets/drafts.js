// ─── Composer drafts ─────────────────────────────────────────────────────────
// Persist the composer textarea's content to localStorage per (ticket, tab)
// so an agent can switch tickets mid-draft without losing work. The key
// embeds COMPOSE_TAB so a partial reply and a partial internal note on the
// same ticket coexist independently.
//
// COMPOSE_TAB comes from core/state.js via the global lexical env.

function getDraftKey(id) { return `draft:${id}:${COMPOSE_TAB}`; }

export function loadDraft(id)   { return localStorage.getItem(getDraftKey(id)) || ''; }

export function saveDraft(id, value) {
  if (value && value.length) localStorage.setItem(getDraftKey(id), value);
  else localStorage.removeItem(getDraftKey(id));
}

export function clearDraft(id) { localStorage.removeItem(getDraftKey(id)); }
