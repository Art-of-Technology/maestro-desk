import { SESSION } from '../core/state.js';
import { CANNED_RESPONSES } from '../core/data.js';
import { apiGet, apiPatch, getJwt, getWorkspaceId } from '../core/api-client.js';
import { registerActions } from '../core/event-delegation.js';

const endpoint = '/api/v1/me/template-favourites';
let active;
function scope() {
  return JSON.stringify([SESSION?.userId || `demo:${SESSION?.role}:${SESSION?.name}`, getWorkspaceId(), getJwt()]);
}
function current(state) { return active === state && state.scope === scope(); }
function notify(state) {
  if (current(state)) globalThis.window?.dispatchEvent?.(new Event('respovia:template-favourites'));
}
export function templateKey(template) { return template._uuid || template.id; }

export function templateFavourites() {
  if (!active || active.scope !== scope()) {
    active = { scope: scope(), remote: !!(SESSION?.userId && getWorkspaceId() && getJwt()),
      pins: new Set(), pending: new Set(), loaded: false, loading: false, error: '', loadError: false };
    if (!active.remote) active.loaded = true;
  }
  return active;
}

export async function loadTemplateFavourites() {
  const state = templateFavourites();
  if (!state.remote || state.loading || state.pending.size) return;
  state.loading = true;
  state.error = ''; state.loadError = false;
  try {
    const result = await apiGet(endpoint, { signal: AbortSignal.timeout(10000) });
    if (!current(state)) return;
    if (!Array.isArray(result?.favourites) || !result.favourites.every(id => typeof id === 'string')) throw Error('Invalid favourites');
    state.pins = new Set(result.favourites);
    state.loaded = true;
  } catch {
    if (current(state)) { state.error = 'Couldn’t load favourites. Try again.'; state.loadError = true; }
  } finally {
    state.loading = false;
    notify(state);
  }
}

export async function toggleTemplateFavourite(key) {
  const state = templateFavourites();
  const template = CANNED_RESPONSES.find(t => templateKey(t) === key);
  if (!template || !state.loaded || state.loading || state.pending.has(key)) return;
  const pinned = !state.pins.has(key);
  state.pending.add(key); state.error = '';
  notify(state);
  try {
    if (state.remote) {
      if (!template._uuid) throw Error('Template is not saved');
      const result = await apiPatch(`${endpoint}/${encodeURIComponent(key)}`, { pinned }, { signal: AbortSignal.timeout(10000) });
      if (result?.template_id !== key || result.pinned !== pinned) throw Error('Invalid favourite');
    }
    if (!current(state)) return;
    if (pinned) state.pins.add(key); else state.pins.delete(key);
  } catch {
    if (current(state)) state.error = 'Couldn’t save this favourite. Try pinning or unpinning it again.';
  } finally {
    state.pending.delete(key);
    notify(state);
  }
}

export function favouriteButton(template) {
  const state = templateFavourites(), key = templateKey(template), pinned = state.pins.has(key);
  return `<button type="button" class="btn btn-sm template-pin" data-action="templateFavourites.toggle" data-template-key="${window.escAttr(key)}" aria-pressed="${pinned}" aria-busy="${state.pending.has(key)}" aria-disabled="${!state.loaded || state.loading || state.pending.has(key)}" aria-label="${window.escAttr(`${pinned ? 'Unpin' : 'Pin'} ${template.name}`)}" ${!state.loaded || state.loading ? 'disabled' : ''}>${state.pending.has(key) ? 'Saving…' : pinned ? 'Unpin' : 'Pin'}</button>`;
}

export function favouriteStatus() {
  const state = templateFavourites();
  if (state.remote && !state.loaded && !state.loading && !state.loadError) void loadTemplateFavourites();
  return `<span role="status">${state.loading ? 'Loading favourites…' : window.escHtml(state.error)}</span>${state.loadError && !state.loading ? ' <button type="button" class="btn btn-sm" data-action="templateFavourites.retry">Retry favourites</button>' : ''}`;
}

export function favouritesRow(ticketId) {
  const state = templateFavourites();
  const pinned = CANNED_RESPONSES.filter(t => state.pins.has(templateKey(t)));
  return `<div class="template-favourites-heading">Favourites</div><div class="template-favourites-links">${pinned.length ? pinned.map(t => `<button type="button" class="btn btn-sm" data-action="templateFavourites.insert" data-ticket-id="${window.escAttr(ticketId)}" data-template-key="${window.escAttr(templateKey(t))}" title="${window.escAttr(t.name)}">${window.escHtml(t.name)}</button>`).join('') : '<span>Pin templates in the picker for quick access here.</span>'}</div><div class="template-favourites-status">${favouriteStatus()}</div>`;
}

registerActions({
  'templateFavourites.toggle': ds => void toggleTemplateFavourite(ds.templateKey),
  'templateFavourites.retry': () => void loadTemplateFavourites(),
});
