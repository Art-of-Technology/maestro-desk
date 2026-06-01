// Real-time presence + collaboration on a single ticket. Tracks which
// agents currently have this ticket open and which of them are typing
// a reply, so the rest of the team can see at a glance and avoid
// double-handling.
//
// Transport: short-poll the API every HEARTBEAT_MS. Each heartbeat
// POSTs our composing flag and returns the OTHER viewers' chips —
// one round-trip per beat. No SDK, no websocket, no extra dependency.
//
// Lifecycle:
//   startPresence(ticketUuid)  — call from openTicket()
//   stopPresence()             — call from app.js renderPage() (any
//                                navigation away clears CURRENT_TICKET)
//   setComposing(bool)         — call from the compose textarea oninput
//   confirmIfOthersComposing() — call from sendCompose() to surface
//                                the soft warning before send
//
// Demo personas have no t._uuid, so this whole module no-ops for them
// — they keep working in the localStorage-only world they're used to.

import { apiPost, apiDelete, API_BASE, getJwt, getWorkspaceId } from '../core/api-client.js';

const HEARTBEAT_MS = 5000;

const state = {
  ticketUuid:    null,     // current ticket's real UUID, or null
  intervalId:    null,     // setInterval handle
  composing:     false,    // local composing flag (driven by oninput)
  viewers:       [],       // last known other-viewers array
  inFlight:      false,    // in-flight beat guard so a slow request can't queue
};

export function startPresence(ticketUuid) {
  if (!ticketUuid) { stopPresence(); return; }
  if (state.ticketUuid === ticketUuid) {
    // Same ticket reopened — likely a re-render after an edit. Re-paint
    // chips into the fresh DOM in case the slot got replaced.
    renderChips();
    renderBanner();
    return;
  }
  // Different ticket — release the old one immediately.
  if (state.ticketUuid) {
    sendLeaveBeacon(state.ticketUuid);
  }
  state.ticketUuid = ticketUuid;
  state.composing  = false;
  state.viewers    = [];
  // First beat is immediate so chips appear in <1s for everyone else.
  tick();
  if (state.intervalId) clearInterval(state.intervalId);
  state.intervalId = setInterval(tick, HEARTBEAT_MS);
}

export function stopPresence() {
  if (state.intervalId) {
    clearInterval(state.intervalId);
    state.intervalId = null;
  }
  if (state.ticketUuid) {
    sendLeaveBeacon(state.ticketUuid);
    state.ticketUuid = null;
  }
  state.composing = false;
  state.viewers   = [];
  // Wipe any leftover chips/banner since the host element survives.
  renderChips();
  renderBanner();
}

export function setComposing(next) {
  const want = !!next;
  if (state.composing === want) return;
  state.composing = want;
  // Beat immediately on transition so the other side sees the typing dot
  // (or its absence) without waiting up to 5s.
  if (state.ticketUuid) tick();
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
  if (!state.ticketUuid) return;
  if (state.inFlight) return;          // skip; next interval will retry
  state.inFlight = true;
  const uuid = state.ticketUuid;
  try {
    const res = await apiPost(`/api/v1/tickets/${uuid}/presence`, { composing: state.composing });
    // Ignore late responses for a ticket we've since left.
    if (state.ticketUuid !== uuid) return;
    state.viewers = Array.isArray(res?.viewers) ? res.viewers : [];
    renderChips();
    renderBanner();
  } catch (err) {
    // JWT expired or membership revoked — every subsequent beat would
    // also fail. Stop the interval and wipe state so we don't churn the
    // network indefinitely. Skip the leave beacon (it would 401 too) —
    // the row will age out of the read window in VIEWER_WINDOW_S.
    if (err?.status === 401 || err?.status === 403) {
      console.warn('[presence] auth failed — stopping heartbeat');
      if (state.intervalId) { clearInterval(state.intervalId); state.intervalId = null; }
      state.ticketUuid = null;
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

// sendBeacon doesn't natively support DELETE, but it sends keepalive on
// page unload — using fetch with keepalive:true gives us the same
// fire-and-forget guarantee for the DELETE shape we need.
function sendLeaveBeacon(uuid) {
  const jwt = getJwt();
  const wsId = getWorkspaceId();
  if (!jwt || !wsId) return;
  try {
    fetch(`${API_BASE}/api/v1/tickets/${uuid}/presence`, {
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
    if (state.ticketUuid) sendLeaveBeacon(state.ticketUuid);
  });
}
