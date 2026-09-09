// Always-on polling of /tickets/sync. Watches for ticket-level changes
// (status, assignment, priority, snooze, merge, sentiment, deletes) +
// new tickets arriving via email/portal/API. Keeps the TICKETS array
// fresh in the background so the list view, "Needs attention"
// chip count, and sidebar nav badges stay live regardless of which
// page the agent is currently on.
//
// Lifecycle:
//   startListSync()  — call after login (real-auth only)
//   stopListSync()   — call from logout
//
// Demo personas never call start (they have no _uuid tickets and no
// API to poll); the localStorage-only flow stays untouched.
//
// Cadence is a 60s FALLBACK since the Pubby realtime push (js/core/
// realtime.js) now triggers tick() the instant a ticket changes. When Pubby
// is configured this poll is just a safety net for a dropped socket; when it
// isn't (or the browser can't reach Pubby) this is the only path and still
// keeps the list live. First call stamps the server's clock as the cursor;
// subsequent calls pull deltas since the last cursor.

import { CURRENT_PAGE, CURRENT_TICKET } from '../core/state.js';
import { renderPage, updateNavBadges } from '../core/router.js';
import { apiGet, getWorkspaceId, getJwt } from '../core/api-client.js';
import { updateOrInsertTicket, buildTicketLookups } from '../core/bootstrap.js';
import { invalidateWorkQueue } from './work-queue.js';
import { invalidateDashboard } from '../dashboard/index.js';

const POLL_INTERVAL_MS = 60000;

const state = {
  intervalId: null,
  cursor:     null,
  inFlight:   false,
};

export function startListSync() {
  if (state.intervalId) return;
  state.cursor   = null;
  state.inFlight = false;
  // First beat is immediate — establishes the cursor with the server's
  // clock so subsequent deltas line up with server time, not client.
  tick();
  state.intervalId = setInterval(tick, POLL_INTERVAL_MS);
}

export function stopListSync() {
  if (state.intervalId) {
    clearInterval(state.intervalId);
    state.intervalId = null;
  }
  state.cursor   = null;
  state.inFlight = false;
}

// Exported so the Pubby realtime push can trigger an immediate delta-pull on
// a `ticket.changed` event. The inFlight guard coalesces a burst of events
// (and an overlapping poll) into a single in-flight fetch — the cursor still
// captures every delta.
export async function tick() {
  if (state.inFlight) return;
  state.inFlight = true;
  const workspace = getWorkspaceId(), jwt = getJwt();
  try {
    const path = state.cursor
      ? `/api/v1/tickets/sync?cursor=${encodeURIComponent(state.cursor)}`
      : `/api/v1/tickets/sync`;
    const res = await apiGet(path);
    if (workspace !== getWorkspaceId() || jwt !== getJwt()) return;

    if (res?.cursor) state.cursor = res.cursor;

    invalidateWorkQueue();
    invalidateDashboard();

    const rows = Array.isArray(res?.tickets) ? res.tickets : [];

    // Build customer + user lookup maps once per batch (rather than once
    // per row inside updateOrInsertTicket) so a 50-row response doesn't
    // rebuild them 50 times.
    const lookups = buildTicketLookups();
    for (const row of rows) {
      updateOrInsertTicket(row, lookups);
    }

    // Re-render the active list view if we're on one. Other pages
    // pull the fresh TICKETS data on their next render naturally.
    // CURRENT_PAGE is a state.js global (classic <script>), read bare like
    // every other module — it is NOT a window property (a top-level `let`
    // doesn't attach to window, so window.CURRENT_PAGE was always undefined).
    const page = CURRENT_PAGE;
    if ((page === 'tickets' && !CURRENT_TICKET) || page === 'dashboard') renderPage(page);
    // Nav badges read off TICKETS too — refresh regardless of page so
    // the sidebar counts don't go stale while the agent is elsewhere.
    if (typeof updateNavBadges === 'function') {
      updateNavBadges();
    }
  } catch (err) {
    // Auth expiry → stop. Same shape as presence's 401/403 path: every
    // subsequent beat would fail identically, so don't churn the network.
    if (err?.status === 401 || err?.status === 403) {
      console.warn('[list-sync] auth failed — stopping');
      stopListSync();
      return;
    }
    console.warn('[list-sync] failed:', err?.status || '', err?.message);
  } finally {
    state.inFlight = false;
  }
}
