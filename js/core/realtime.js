// Pubby realtime (migration — Step 5). Replaces the chatty list-sync poll with
// a WebSocket push: the server triggers a tiny `ticket.changed` signal on the
// workspace's private channel, and we react by running the EXISTING cursor
// sync (list/TICKETS) + reloading the open ticket's detail. No payload trust —
// the fetch is the source of truth, so a missed event is self-healing (and the
// 60s fallback poll in list-sync.js backstops a dropped socket).
//
// Purely additive: if Pubby isn't configured (GET /pubby/config returns no
// key/host) or unreachable, startRealtime() no-ops and polling carries the app.
//
// Lifecycle mirrors list-sync: startRealtime() after login, stopRealtime() on
// logout (both wired in app.js).

import PubbySdk from '../vendor/pubby.js';
import { apiGet, API_BASE, getJwt, getWorkspaceId } from './api-client.js';

// The vendored build's default export is the SDK namespace; the client class
// is its `.Pubby` member.
const { Pubby } = PubbySdk;
import { tick as listSyncTick } from '../tickets/list-sync.js';
import { reloadTicketByUuid } from '../tickets/detail.js';

let _pubby = null;

export async function startRealtime() {
  if (_pubby) return;
  const workspaceId = getWorkspaceId();
  if (!workspaceId) return;

  let cfg;
  try {
    cfg = await apiGet('/api/v1/pubby/config');
  } catch {
    return;   // can't reach config → stay on fallback polling
  }
  if (!cfg?.key || !cfg?.ws_host) return;   // realtime not configured

  const pubby = new Pubby(cfg.key, {
    wsHost: cfg.ws_host,
    authEndpoint: `${API_BASE}/api/v1/pubby/auth`,
    // The SDK merges these headers into its auth POST so /pubby/auth can verify
    // the Better Auth session + workspace before signing the private channel.
    // The bearer is snapshotted here, which is fine: our session tokens don't
    // rotate mid-session, stopRealtime() runs on logout, and a stale token
    // would just fail the auth endpoint (the channel stays unsubscribed and
    // the fallback poll carries on) — no incorrect state.
    auth: { headers: { Authorization: `Bearer ${getJwt()}`, 'X-Workspace-Id': workspaceId } },
  });
  _pubby = pubby;
  pubby.connect();

  const channel = pubby.subscribe(`private-ws-${workspaceId}-tickets`);
  channel.bind('ticket.changed', (data) => {
    // Signal → fetch. Pull the cursor delta into the list/TICKETS, and if the
    // changed ticket is the one open, reload its detail immediately.
    listSyncTick();
    if (data && typeof data.id === 'string') reloadTicketByUuid(data.id);
  });
}

export function stopRealtime() {
  if (!_pubby) return;
  try { _pubby.disconnect(); } catch { /* best-effort */ }
  _pubby = null;
}
