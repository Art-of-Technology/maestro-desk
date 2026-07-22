// ─── Player lookup (live, brand-scoped) ──────────────────────────────────────
// A customer and a player are the same entity. This sub-module lets an agent
// look a player up LIVE from the selected Maestro brand — including players who
// have never contacted support (so have no local customer record yet) — and, in
// one click, start a conversation with them (creates the local customer + opens
// a ticket to email from).
//
// The platform endpoint is lookup-by-ONE-exact-key (email/username, numeric
// member id, or Maestro user id) returning a single member — NOT a partial-name
// browse/search. So the UI is "pick a key type, enter the value, see that one
// player (or 'not found')", not a results list.
//
// Backend: GET /api/v1/maestro/players?<key>=<val> (single member, {brand:true}
// attaches X-Brand-Id; uses the app token server-side). Start-a-conversation:
// POST /api/v1/customers/from-player then POST /api/v1/tickets, then we reload
// workspace data and open the new ticket. Read-only otherwise — a lookup never
// writes anything locally until the agent chooses to start a conversation.
//
// Lives under the Customers page: renderCustomers() in ./index.js delegates to
// renderPlayerLookupView() whenever playerLookupActive() is true. router.js
// calls resetPlayerLookup() on nav away from customers. escHtml/escAttr come
// from the window bridge, as elsewhere.

import { apiGet, apiPost, getBrandId } from '../core/api-client.js';
import { renderPage } from '../core/router.js';
import { setCustomerSelected } from '../core/state.js';
import { CUSTOMERS } from '../core/data.js';
import { loadWorkspaceData } from '../core/bootstrap.js';
import { openTicket } from '../tickets/detail.js';
import { registerActions, registerChangeActions, registerInputActions } from '../core/event-delegation.js';

// ─── Module state ─────────────────────────────────────────────────────────────
let LOOKUP_OPEN = false;          // are we in the lookup view (vs the normal list)?
let LOOKUP_BY = 'email';          // 'email' (email or username) | 'memberId' | 'maestroUserId'
let LOOKUP_VALUE = '';            // current input value
let LOOKUP_STATE = 'idle';        // 'idle' | 'loading' | 'done' | 'notfound' | 'error'
let PLAYER = null;                // normalized member when state==='done'
let LOOKUP_ERROR = null;          // user-facing error string
let STARTING = false;             // start-a-conversation in flight

const KEY_LABELS = { email: 'Email or username', memberId: 'Member ID', maestroUserId: 'Maestro user ID' };

export function playerLookupActive() { return LOOKUP_OPEN; }

export function resetPlayerLookup() {
  LOOKUP_OPEN = false;
  LOOKUP_BY = 'email';
  LOOKUP_VALUE = '';
  LOOKUP_STATE = 'idle';
  PLAYER = null;
  LOOKUP_ERROR = null;
  STARTING = false;
}

// ─── Data fetch + normalization ─────────────────────────────────────────────

async function runLookup() {
  const el = document.getElementById('player-lookup-input');
  const value = (el ? el.value : LOOKUP_VALUE).trim();
  LOOKUP_VALUE = value;
  if (!value) return;
  LOOKUP_STATE = 'loading';
  LOOKUP_ERROR = null;
  PLAYER = null;
  renderPage('customers');
  try {
    const res = await apiGet(`/api/v1/maestro/players?${LOOKUP_BY}=${encodeURIComponent(value)}`, { brand: true });
    PLAYER = normalizePlayer(res.member || {});
    LOOKUP_STATE = 'done';
  } catch (err) {
    if (err?.status === 404) {
      LOOKUP_STATE = 'notfound';
    } else {
      LOOKUP_STATE = 'error';
      // 400 = no brand selected; 503 = lookup not configured; 502 = gateway down.
      LOOKUP_ERROR = err?.message || 'Player lookup failed.';
    }
  }
  if (LOOKUP_OPEN) renderPage('customers');
}

function normalizePlayer(m) {
  m = m || {};
  const first = m.firstName ?? '';
  const last = m.lastName ?? '';
  const username = m.username ?? '';
  const email = m.email ?? '';
  const name = `${first} ${last}`.trim() || username || email || '(unnamed player)';
  return {
    id: m.userId ?? m.memberId ?? m.id ?? '',
    name, first, last, username, email,
    mobile: m.mobile ?? '',
    vip: m.vipLevel ?? '',
    kyc: m.kycStatus ?? '',
    country: m.country ?? '',
    balance: m.balance,
    balanceCy: m.balanceCy ?? '',
    dob: m.dob ?? '',
    sex: m.sex ?? '',
    city: m.city ?? '',
    _raw: m,
  };
}

// A looked-up player who has also contacted support exists in the local
// CUSTOMERS list — match on email (case-insensitive) to offer a jump to their
// ticket history.
function localMatchFor(player) {
  if (!player?.email) return null;
  const e = player.email.toLowerCase();
  return CUSTOMERS.find(c => (c.email || '').toLowerCase() === e) || null;
}

// ─── Start a conversation ─────────────────────────────────────────────────────
// Create/find the local customer from the player, open a ticket, then land the
// agent in that ticket so they can compose the outbound email.
async function startConversation() {
  if (!PLAYER || STARTING) return;
  STARTING = true;
  renderPage('customers');
  try {
    const cust = await apiPost('/api/v1/customers/from-player', { email: PLAYER.email }, { brand: true });
    const customerId = cust?.customer?.id;
    if (!customerId) throw new Error('Could not create the customer record.');
    const subject = `Outreach to ${PLAYER.first || PLAYER.name}`.trim();
    const res = await apiPost('/api/v1/tickets', { customer_id: customerId, subject });
    const displayId = res?.ticket?.display_id;
    // Refresh the in-memory tickets + customers so the new ticket is openable.
    await loadWorkspaceData();
    resetPlayerLookup();
    if (displayId) openTicket(displayId);
    else renderPage('tickets');
  } catch (err) {
    STARTING = false;
    LOOKUP_ERROR = err?.message || 'Could not start the conversation.';
    LOOKUP_STATE = 'error';
    if (LOOKUP_OPEN) renderPage('customers');
  }
}

// ─── Rendering ────────────────────────────────────────────────────────────────

export function renderPlayerLookupView() {
  return renderPlayerLookup();
}

function renderPlayerLookup() {
  let result = '';
  if (LOOKUP_STATE === 'loading') {
    result = `<div style="color:var(--ink3);font-size:13px;text-align:center;padding:28px 0">Looking up ${window.escHtml(LOOKUP_VALUE)}…</div>`;
  } else if (LOOKUP_STATE === 'notfound') {
    result = `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No player found for that ${window.escHtml(KEY_LABELS[LOOKUP_BY].toLowerCase())}</div><div class="empty-line"></div></div>`;
  } else if (LOOKUP_STATE === 'error') {
    result = `<div class="card" style="border-color:rgba(199,58,44,0.3);background:var(--red-lt)"><div style="color:var(--red);font-size:13px">${window.escHtml(LOOKUP_ERROR)}</div></div>`;
  } else if (LOOKUP_STATE === 'done' && PLAYER) {
    result = renderPlayerCard(PLAYER);
  } else {
    result = `<div style="color:var(--ink3);font-size:13px;text-align:center;padding:28px 0">Enter a player's exact email/username, member ID, or Maestro ID to pull their live record.</div>`;
  }

  const opt = (v) => `<option value="${v}" ${LOOKUP_BY === v ? 'selected' : ''}>${KEY_LABELS[v]}</option>`;
  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-breadcrumb">
          <span data-action="players.close">Customers</span>
          <span class="tb-sep">/</span>
          <span style="color:var(--ink);font-weight:500">Look up player</span>
        </div>
      </div>
      <div class="page-scroll">
        <div class="card" style="margin-bottom:16px">
          <div class="card-title">Find a player in this brand</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <select class="filter-select" data-change-action="players.setBy" style="width:180px">
              ${opt('email')}${opt('memberId')}${opt('maestroUserId')}
            </select>
            <input id="player-lookup-input" class="filter-select" style="flex:1;min-width:220px;max-width:420px"
              placeholder="${window.escAttr(KEY_LABELS[LOOKUP_BY])}…" value="${window.escAttr(LOOKUP_VALUE)}"
              data-input-action="players.setValue"/>
            <button class="btn btn-sm btn-solid" data-action="players.run">Look up</button>
          </div>
          <div style="font-size:11px;color:var(--ink3);margin-top:8px;line-height:1.5">Live from Maestro Connect. Lookup is by an exact key — not a name search. Nothing is stored locally until you start a conversation.</div>
        </div>
        ${result}
      </div>
    </div>`;
}

function vipChip(vip) {
  if (vip === '' || vip === null || vip === undefined) return '';
  return `<span class="tag tag-neutral">VIP ${window.escHtml(vip)}</span>`;
}

function renderPlayerCard(p) {
  const local = localMatchFor(p);
  const balance = (p.balance !== undefined && p.balance !== null)
    ? `${p.balance}${p.balanceCy ? ' ' + p.balanceCy : ''}` : '';
  const rows = [
    ['Email', p.email],
    ['Username', p.username],
    ['Mobile', p.mobile],
    ['VIP level', p.vip],
    ['KYC', p.kyc],
    ['Country', p.country],
    ['Balance', balance],
    ['Date of birth', p.dob],
    ['Sex', p.sex],
    ['City', p.city],
    ['Player ID', p.id],
  ].filter(([, v]) => v !== '' && v != null);

  // Dump any further primitive fields (incl. flattened attributes) we didn't map
  // explicitly, so nothing the gateway returned is hidden.
  const mapped = new Set(['userId', 'memberId', 'id', 'firstName', 'lastName', 'username', 'email',
    'mobile', 'vipLevel', 'kycStatus', 'country', 'balance', 'balanceCy', 'dob', 'sex', 'city',
    'success', 'errorCode', 'errorDesc']);
  const extra = [];
  for (const [k, v] of Object.entries(p._raw || {})) {
    if (mapped.has(k)) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') extra.push([k, String(v)]);
    else if (v && typeof v === 'object') {
      for (const [k2, v2] of Object.entries(v)) {
        if (typeof v2 === 'string' || typeof v2 === 'number' || typeof v2 === 'boolean') extra.push([`${k}.${k2}`, String(v2)]);
      }
    }
  }

  return `
    <div style="display:flex;gap:14px;align-items:center;padding:4px 0 18px;border-bottom:1px solid var(--rule);margin-bottom:18px">
      <div style="width:52px;height:52px;border-radius:50%;background:var(--ink);display:flex;align-items:center;justify-content:center;font-weight:600;color:#fff;font-size:15px;flex-shrink:0">${window.escHtml((p.first || p.name || '?').charAt(0))}${window.escHtml((p.last || '').charAt(0))}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:17px;font-weight:600;color:var(--ink)">${window.escHtml(p.name)}</div>
        <div style="font-size:12px;color:var(--ink3);margin-top:4px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          ${p.id ? `<span style="font-family:'DM Mono',monospace">${window.escHtml(p.id)}</span>` : ''}
          ${vipChip(p.vip)}
          ${p.country ? `<span style="font-family:'DM Mono',monospace">${window.escHtml(p.country)}</span>` : ''}
        </div>
      </div>
      <span class="tag tag-neutral" style="flex-shrink:0">Live · Maestro</span>
    </div>
    ${local
      ? `<div class="card" style="margin-bottom:16px;border-color:var(--purple);background:var(--purple-lt)">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <span style="font-size:12px;color:var(--purple);font-weight:600">This player has contacted support before.</span>
            <button class="btn btn-sm" style="margin-left:auto" data-action="players.openLocal" data-email="${window.escAttr(p.email)}">View support history →</button>
          </div>
        </div>`
      : `<div class="card" style="margin-bottom:16px">
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
            <div style="font-size:12px;color:var(--ink2);flex:1;min-width:200px">No support history yet — they've never opened a ticket. Start a conversation to reach out (this creates their customer record and opens a ticket you can email from).</div>
            <button class="btn btn-sm btn-solid" ${STARTING ? 'disabled' : ''} data-action="players.startConvo">${STARTING ? 'Starting…' : '✉ Start a conversation'}</button>
          </div>
        </div>`}
    <div class="card" style="margin-bottom:16px">
      <div class="card-title">Profile</div>
      ${rows.map(([k, v]) => `<div class="ts-row"><span class="ts-key">${window.escHtml(k)}</span><span class="ts-val">${window.escHtml(v)}</span></div>`).join('')}
    </div>
    ${extra.length ? `
      <div class="card">
        <div class="card-title">Additional fields</div>
        ${extra.map(([k, v]) => `<div class="ts-row"><span class="ts-key">${window.escHtml(k)}</span><span class="ts-val">${window.escHtml(v)}</span></div>`).join('')}
      </div>` : ''}`;
}

function openLocalCustomer(email) {
  const e = (email || '').toLowerCase();
  const local = CUSTOMERS.find(c => (c.email || '').toLowerCase() === e);
  if (!local) return;
  resetPlayerLookup();
  setCustomerSelected(local.id);
  renderPage('customers');
}

// ─── Actions ──────────────────────────────────────────────────────────────────
registerActions({
  'players.lookup':    () => { LOOKUP_OPEN = true; renderPage('customers'); },
  'players.run':       () => runLookup(),
  'players.startConvo':() => startConversation(),
  'players.openLocal': (ds) => openLocalCustomer(ds.email),
  'players.close':     () => { resetPlayerLookup(); renderPage('customers'); },
});

registerChangeActions({
  'players.setBy': (ds, el) => { LOOKUP_BY = el.value; },
});

registerInputActions({
  'players.setValue': (ds, el) => { LOOKUP_VALUE = el.value; },
});
