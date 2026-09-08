import { COMPOSE_TAB, SESSION } from '../core/state.js';
import { getWorkspaceId } from '../core/api-client.js';
// ─── Composer drafts ─────────────────────────────────────────────────────────
// Persist the composer textarea's content to localStorage per (ticket, tab)
// so an agent can switch tickets mid-draft without losing work. The key
// embeds COMPOSE_TAB so a partial reply and a partial internal note on the
// same ticket coexist independently.
//
// COMPOSE_TAB is imported from core/state.js.

// The tab is an explicit parameter defaulting to the live COMPOSE_TAB, so a
// caller that knows which tab it means (the new-ticket flow always writes a
// customer-facing 'reply' draft) doesn't have to move the app-wide global to
// address the right key.
// Display numbers repeat across workspaces; browsers can also be shared by
// agents. Legacy unscoped drafts cannot safely be attributed to either, so
// leave them stored without automatically attaching them to a conversation.
function getDraftPrefix(id) {
  return `draft:v2:${getWorkspaceId() || 'demo'}:${SESSION?.userId || 'demo'}:${id}:`;
}
function getDraftKey(id, tab = COMPOSE_TAB) { return getDraftPrefix(id) + tab; }

export function loadDraft(id, tab)   { return localStorage.getItem(getDraftKey(id, tab)) || ''; }

export function saveDraft(id, value, tab) {
  const key = getDraftKey(id, tab);
  if (value && value.length) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
}

export function clearDraft(id, tab) { localStorage.removeItem(getDraftKey(id, tab)); }

// Remove EVERY tab's draft for a ticket (reply + internal note) — used when
// the ticket itself is deleted, where clearing only the active COMPOSE_TAB
// would leave the other tab's draft orphaned in localStorage forever.
export function clearAllDrafts(id) {
  const prefix = getDraftPrefix(id);
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) localStorage.removeItem(k);
  }
}
