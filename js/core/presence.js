// Real-time presence + collaboration, generalised across entity types.
// Originally per-ticket (PR #236, in js/tickets/presence.js); lifted
// to core/ in PR #239 so customer detail, KB editor, etc. can opt in
// with the same lifecycle:
//
//   startPresence(entityType, entityId)  — call on entity-open
//   stopPresence()                       — call on nav-away / logout
//   setComposing(bool)                   — call from compose oninput
//   confirmIfOthersComposing()           — call before destructive send
//   setTicketChangedCallback(cb)         — ticket-only: fires when the
//                                          server's ticket_updated_at
//                                          advances since last beat
//                                          (drives live-detail sync)
//
// Transport: short-poll the API every HEARTBEAT_MS. Each heartbeat
// POSTs the composing flag and returns the OTHER viewers' chips plus
// (for entity_type='ticket') the current ticket_updated_at. One
// round-trip per beat. No SDK.
//
// Demo personas have no _uuid, so callers gate startPresence on a
// real UUID. This module no-ops cleanly when nothing is active.

import { apiPost, API_BASE, getJwt, getWorkspaceId } from './api-client.js';

const HEARTBEAT_MS = 5000;

const state = {
  entityType:          null,   // 'ticket' | 'customer' | ... or null when idle
  entityId:            null,   // UUID of the active entity, or null
  intervalId:          null,
  composing:           false,
  viewers:             [],
  inFlight:            false,
  lastTicketUpdatedAt: null,   // only meaningful when entityType === 'ticket'
};

// Ticket-detail live-sync callback. Module-scoped so it survives
// across openTicket re-renders. Registered once at detail.js module
// load; fires from tick() when the server reports a newer ticket
// updated_at than we've seen.
let onTicketChanged = null;
export function setTicketChangedCallback(cb) {
  onTicketChanged = typeof cb === 'function' ? cb : null;
}

export function startPresence(entityType, entityId) {
  if (!entityType || !entityId) { stopPresence(); return; }
  if (state.entityType === entityType && state.entityId === entityId) {
    // Same entity reopened — likely a re-render after an edit. Re-paint
    // chips into the fresh DOM in case the slot got replaced.
    renderChips();
    renderBanner();
    return;
  }
  // Different entity — release the old one immediately.
  if (state.entityType && state.entityId) {
    sendLeaveBeacon(state.entityType, state.entityId);
  }
  state.entityType          = entityType;
  state.entityId            = entityId;
  state.composing           = false;
  state.viewers             = [];
  state.lastTicketUpdatedAt = null;
  tick();
  if (state.intervalId) clearInterval(state.intervalId);
  state.intervalId = setInterval(tick, HEARTBEAT_MS);
}

export function stopPresence() {
  if (state.intervalId) {
    clearInterval(state.intervalId);
    state.intervalId = null;
  }
  if (state.entityType && state.entityId) {
    sendLeaveBeacon(state.entityType, state.entityId);
    state.entityType = null;
    state.entityId   = null;
  }
  state.composing = false;
  state.viewers   = [];
  renderChips();
  renderBanner();
}

export function setComposing(next) {
  const want = !!next;
  if (state.composing === want) return;
  state.composing = want;
  if (state.entityType && state.entityId) tick();
}

/**
 * Returns the subset of viewers currently composing. Used by the
 * send-confirm flow to surface a warning before two agents send
 * competing replies.
 */
export function composingViewers() {
  return state.viewers.filter(v => v.composing);
}

/**
 * Soft-block on send when another agent is also composing. Resolves
 * to true when the agent confirms (or no-one else is composing), and
 * false when the agent cancels.
 *
 * Uses an in-app modal rather than native window.confirm so the
 * dialog matches the rest of the app visually and doesn't freeze
 * the JS thread the way native confirm does on some browsers.
 */
export function confirmIfOthersComposing() {
  const composers = composingViewers();
  if (composers.length === 0) return Promise.resolve(true);
  const names = composers.map(v => v.name).join(', ');
  const verb  = composers.length === 1 ? 'is also replying' : 'are also replying';
  return showPresenceConfirm(names, verb);
}

// Custom-rolled dialog instead of core/modal.js' showModal — that helper's
// background-click and × dismiss bypass the onConfirm callback (they call
// closeModal directly), which would leak the pending promise on cancel.
// Every dismiss path here routes through finish() so the promise always
// settles. window.__presenceConfirm carries the inline-onclick callback
// since the markup is dropped in via innerHTML.
function showPresenceConfirm(names, verb) {
  return new Promise(resolve => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      delete window.__presenceConfirm;
      const c = document.getElementById('modal-container');
      if (c) c.innerHTML = '';
      resolve(ok);
    };
    window.__presenceConfirm = finish;
    const container = document.getElementById('modal-container');
    if (!container) return finish(true);  // no modal slot — fall through optimistically
    container.innerHTML = `
      <div class="modal-bg" onclick="window.__presenceConfirm(false)">
        <div class="modal" onclick="event.stopPropagation()">
          <div class="modal-head">
            <div class="modal-title">Others are replying</div>
            <div class="modal-close" onclick="window.__presenceConfirm(false)">×</div>
          </div>
          <div class="modal-body">
            <p style="margin:0 0 6px;font-size:13px;color:var(--ink);line-height:1.5"><strong>${escHtml(names)}</strong> ${escHtml(verb)} to this ticket.</p>
            <p style="margin:0;font-size:12px;color:var(--ink2);line-height:1.5">Sending now could result in conflicting replies to the customer.</p>
          </div>
          <div class="modal-foot">
            <button class="btn" onclick="window.__presenceConfirm(false)">Cancel</button>
            <button class="btn btn-solid" onclick="window.__presenceConfirm(true)">Send anyway</button>
          </div>
        </div>
      </div>`;
  });
}

async function tick() {
  if (!state.entityType || !state.entityId) return;
  if (state.inFlight) return;
  state.inFlight = true;
  const { entityType, entityId } = state;
  try {
    const res = await apiPost(`/api/v1/presence/${entityType}/${entityId}`, { composing: state.composing });
    // Ignore late responses for an entity we've since left.
    if (state.entityType !== entityType || state.entityId !== entityId) return;
    state.viewers = Array.isArray(res?.viewers) ? res.viewers : [];
    renderChips();
    renderBanner();

    // Ticket-detail live-sync probe: if the server's ticket_updated_at
    // moved since our last beat, fire the change callback. Other entity
    // types skip this branch.
    //
    // Several mutations within one HEARTBEAT_MS window collapse to a
    // single reload — we only ever see the latest updated_at, never the
    // intermediate timestamps. Acceptable for help-desk concurrency.
    if (entityType === 'ticket' && res?.ticket_updated_at) {
      if (state.lastTicketUpdatedAt && res.ticket_updated_at !== state.lastTicketUpdatedAt) {
        if (onTicketChanged) {
          try { onTicketChanged({ uuid: entityId, updatedAt: res.ticket_updated_at }); }
          catch (err) { console.warn('[presence] onTicketChanged callback threw:', err); }
        }
      }
      state.lastTicketUpdatedAt = res.ticket_updated_at;
    }
  } catch (err) {
    // JWT expired or membership revoked — every subsequent beat would
    // also fail. Stop the interval and wipe state so we don't churn the
    // network indefinitely. Skip the leave beacon (it would 401 too) —
    // the row will age out of the read window in VIEWER_WINDOW_S.
    if (err?.status === 401 || err?.status === 403) {
      console.warn('[presence] auth failed — stopping heartbeat');
      if (state.intervalId) { clearInterval(state.intervalId); state.intervalId = null; }
      state.entityType = null;
      state.entityId   = null;
      state.viewers    = [];
      renderChips();
      renderBanner();
      return;
    }
    // Transient failure — log and let the next beat retry.
    console.warn('[presence] heartbeat failed:', err?.status || '', err?.message);
  } finally {
    state.inFlight = false;
  }
}

// fetch keepalive:true gives us the same fire-and-forget guarantee that
// navigator.sendBeacon offers, but supports DELETE (sendBeacon doesn't).
function sendLeaveBeacon(entityType, entityId) {
  const jwt = getJwt();
  const wsId = getWorkspaceId();
  if (!jwt || !wsId) return;
  try {
    fetch(`${API_BASE}/api/v1/presence/${entityType}/${entityId}`, {
      method:    'DELETE',
      keepalive: true,
      headers: {
        'Authorization':   `Bearer ${jwt}`,
        'X-Workspace-Id':  wsId,
      },
    }).catch(() => {});
  } catch { /* swallowed — unload best-effort */ }
}

function renderChips() {
  const slot = document.getElementById('presence-chips');
  if (!slot) return;
  if (!state.viewers.length) { slot.innerHTML = ''; return; }
  slot.innerHTML = state.viewers.map(viewerChip).join('');
}

function viewerChip(v) {
  const title = v.composing ? `${v.name} is typing…` : v.name;
  const ring  = v.composing ? 'var(--purple)' : 'var(--rule2)';
  const dot   = v.composing
    ? '<span class="presence-typing-dot" title="Typing"></span>'
    : '';
  return `<div class="presence-chip" title="${escAttr(title)}" style="border-color:${ring}">
    <span class="presence-chip-initials">${escHtml(v.initials)}</span>
    ${dot}
  </div>`;
}

function renderBanner() {
  const slot = document.getElementById('presence-banner');
  if (!slot) return;
  const composers = composingViewers();
  if (composers.length === 0) { slot.innerHTML = ''; return; }
  const names = composers.map(c => escHtml(c.name)).join(', ');
  const verb  = composers.length === 1 ? 'is replying' : 'are replying';
  slot.innerHTML = `
    <div class="presence-banner">
      <span class="presence-banner-dot"></span>
      <span><strong>${names}</strong> ${verb} to this ticket — heads up before you send.</span>
    </div>`;
}

// Tiny escape helpers — duplicating window.escHtml/escAttr keeps this
// module loadable before app.js wires the global bridge.
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => (
    ch === '&' ? '&amp;' :
    ch === '<' ? '&lt;'  :
    ch === '>' ? '&gt;'  :
    ch === '"' ? '&quot;': '&#39;'
  ));
}
function escAttr(s) { return escHtml(s); }

// Last-ditch cleanup if the tab closes while we're still heartbeating.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (state.entityType && state.entityId) sendLeaveBeacon(state.entityType, state.entityId);
  });
}
