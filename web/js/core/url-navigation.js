import { parseRoute, formatRoute } from './route-location.js';
import { getWorkspaceId, getWorkspaceSlug, getJwt, apiGet } from './api-client.js';
import { CUSTOMERS, TICKETS } from './data.js';
import { CURRENT_PAGE, CUSTOMER_SELECTED, CURRENT_TICKET, SESSION, setCustomerSelected } from './state.js';
import { showToast } from './toast.js';
import { isPlatformAdmin } from './auth-client.js';

const RETURN_ROUTE_KEY = 'respovia_return_route';
let ready = false;
let rendering = false;
let revision = 0;
let lastRenderedHash = null;
let installed = false;

export function requestedRoute() {
  return parseRoute(window.location.hash);
}

export function discardRequestedRoute() {
  sessionStorage.removeItem(RETURN_ROUTE_KEY);
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

// Save only a validated internal destination before OAuth leaves this origin.
export function saveReturnRoute() {
  const route = requestedRoute();
  if (route) sessionStorage.setItem(RETURN_ROUTE_KEY, formatRoute(route));
  else sessionStorage.removeItem(RETURN_ROUTE_KEY);
}

export function restoreReturnRoute() {
  const hash = sessionStorage.getItem(RETURN_ROUTE_KEY);
  sessionStorage.removeItem(RETURN_ROUTE_KEY);
  if (parseRoute(hash)) history.replaceState(null, '', hash);
}

export function suspendUrlRouting() {
  ready = false;
  revision++;
  lastRenderedHash = null;
  sessionStorage.removeItem(RETURN_ROUTE_KEY);
}

function screenRoute(page = CURRENT_PAGE, ticketId = CURRENT_TICKET) {
  const workspaceId = page === 'god' ? null : getWorkspaceId();
  const workspaceSlug = workspaceId ? getWorkspaceSlug() : null;
  const record = page === 'tickets' && ticketId
    ? TICKETS.find(t => t.id === ticketId)
    : page === 'customers' && CUSTOMER_SELECTED
      ? CUSTOMERS.find(c => c.id === CUSTOMER_SELECTED) : null;
  return { workspaceId, workspaceSlug, page, entityId: record ? (workspaceId && !workspaceSlug ? record._uuid : record.id) : null };
}

function screenHash(page, ticketId) {
  try { return formatRoute(screenRoute(page, ticketId)); }
  catch { return null; } // Invalid legacy view-model IDs must not break rendering.
}

// Rendering is also used for background refreshes. Only an actual destination
// change creates history; applying history must never push another entry.
export function syncRoute(page = CURRENT_PAGE, ticketId = CURRENT_TICKET) {
  if (!ready || rendering || !SESSION) return;
  const hash = screenHash(page, ticketId);
  if (!hash || hash === lastRenderedHash) return;
  revision++;
  lastRenderedHash = hash;
  if (window.location.hash !== hash) history.pushState(null, '', hash);
}

export function beginRouteNavigation() {
  if (!ready || rendering) return;
  revision++;
  lastRenderedHash = null;
}

export function initUrlRouting() {
  if (installed) return;
  installed = true;
  window.addEventListener('hashchange', () => {
    if (ready && SESSION) void applyUrlRoute();
  });
}

export async function resumeUrlRouting() {
  ready = true;
  await applyUrlRoute();
}

async function applyUrlRoute() {
  const route = requestedRoute();
  const attempt = ++revision;
  const invalidLink = !route && window.location.hash.startsWith('#/');
  const workspaceId = getWorkspaceId();
  const jwt = getJwt();
  if (jwt && ((route?.workspaceId && route.workspaceId !== workspaceId)
    || (route?.workspaceSlug && route.workspaceSlug !== getWorkspaceSlug()))) {
    // Reload through the normal authenticated bootstrap so membership, roles,
    // brand identity and all cached workspace data change together.
    window.location.reload();
    return;
  }
  const current = () => attempt === revision && ready && SESSION
    && workspaceId === getWorkspaceId() && jwt === getJwt();
  const { nav } = await import('./router.js');
  if (!current()) return;
  let page = route?.page || (isPlatformAdmin() && !workspaceId ? 'god' : 'dashboard');
  let entity = null;
  let error = null;
  try {
    if (page === 'god' && !isPlatformAdmin()) throw new Error('You do not have access to this page.');
    if (route?.entityId) {
      const records = page === 'tickets' ? TICKETS : CUSTOMERS;
      const readable = Boolean(route.workspaceSlug);
      entity = records.find(r => (workspaceId && !readable ? r._uuid : r.id) === route.entityId);
      if (!entity && page === 'tickets' && workspaceId && (route.workspaceId || readable)) {
        const path = readable ? `by-number/${encodeURIComponent(route.entityId)}` : route.entityId;
        const res = await apiGet(`/api/v1/tickets/${path}`);
        if (!current()) return;
        const { updateOrInsertTicket } = await import('./bootstrap.js');
        if (!current()) return;
        updateOrInsertTicket(res.ticket);
        entity = TICKETS.find(t => t._uuid === res.ticket.id);
      }
      if (!entity) throw new Error('This record is unavailable in this workspace.');
    }
  } catch (err) {
    if (!current()) return;
    error = err?.status === 403 || err?.status === 404
      ? 'This record is unavailable in this workspace.'
      : err?.message || 'Could not open this link.';
    if (page === 'god') page = 'dashboard';
  }
  if (!current()) return;
  const { openTicket } = await import('../tickets/detail.js');
  const { resetPlayerLookup } = await import('../customers/player-lookup.js');
  if (!current()) return;
  rendering = true;
  try {
    resetPlayerLookup();
    setCustomerSelected(page === 'customers' && entity ? entity.id : null);
    nav(page);
    if (page === 'tickets' && entity) openTicket(entity.id);
    lastRenderedHash = screenHash(page, entity && page === 'tickets' ? entity.id : null);
    if (lastRenderedHash) history.replaceState(null, '', lastRenderedHash);
  } finally { rendering = false; }
  if (error) showToast(error, 'warn');
  else if (invalidLink) showToast('That link is unavailable. Showing your home page.', 'warn');
}
