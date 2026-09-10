import { applySavedActivity } from '../core/ticket-history.js';
import { copyButton } from '../core/copy.js';
// ─── Tickets list ────────────────────────────────────────────────────────────
// The Tickets index page: KPI bar, status tab bar, filter/group/view chips,
// the multi-select bulk-action bar (assign / status / priority / tag / snooze /
// assignment-rules / macro / export / delete), and the sortable, groupable
// ticket table with row checkboxes.
//
// External reaches (interim, via window): escAttr, escHtml, fmtMinutes —
// all still in app.js. openTicket is a direct ES import from tickets/detail.js;
// showNewTicketModal from tickets/new-ticket.js.
//
// No window-bridge namespace: the page's inline on*= handlers are delegated
// as list.* actions (bottom of file). renderTickets (router + list-sync) and
// initTicketsPage (post-render hook) stay exported; setTicketView stays
// exported (profile.gotoMyTickets imports it). The bulk snooze / run-rules /
// run-macro controls dispatch to actions owned by those modules
// (snooze.bulkSnooze / ar.bulkRun / macros.bulkRun). The FILTER_* set/clear
// handlers assign the core/state.js globals directly, as before.

import { AGENTS, CUSTOMERS, TICKETS } from '../core/data.js';
import { CURRENT_PAGE, CURRENT_TICKET, FILTER_AGENT, FILTER_CATEGORY, FILTER_PRIORITY, FILTER_QUERY, FILTER_SENTIMENT, SESSION, TICKET_SELECTED_IDS, setFilterAgent, setFilterCategory, setFilterPriority, setFilterQuery, setFilterSentiment } from '../core/state.js';
import { renderPage, updateNavBadges } from '../core/router.js';
import { MACROS } from './macros.js';
import { formatSnoozeUntil } from './snooze.js';
import { isAgentOOO } from './assignment-rules.js';
import { ticketTotalMinutes, ticketBillableMinutes } from './time-tracking.js';
import { openTicket, changeTicketStatus } from './detail.js';
import { showCloseTickets } from './closure.js';
import { showNewTicketModal } from './new-ticket.js';
import { logTicketEvent } from '../core/activity-log.js';
import { showModal, closeModal, showDangerConfirm } from '../core/modal.js';
import { showToast } from '../core/toast.js';
import { clearAllDrafts } from './drafts.js';
import { isOutstanding, compareUrgency, workQueueState, loadWorkQueue, refreshQueueUrgency, invalidateWorkQueue } from './work-queue.js';
import { registerActions, registerChangeActions, registerInputActions } from '../core/event-delegation.js';
import { apiGet, apiPost, apiPatch, apiDelete, getJwt, getWorkspaceId } from '../core/api-client.js';
import { saveBulkAssignments } from './bulk-assignment.js';
import { showBulkEdit } from './bulk-edit.js';

// Module-local filter / sort state. Nothing outside this module reads or
// writes these, so they don't need to live in core/state.js.
let FILTER_STATUS = 'outstanding';
let FILTER_VIEW = 'all';
let TICKET_GROUP_BY = 'none';
let TICKET_HEADER_CB_INDETERMINATE = false;
let SORT_COL = 'urgency';
let SORT_DIR = 1;
let VISIBLE_LIMIT = 50;
// The four advanced selects live behind "More filters" (issue #447). Closed by
// default; anything actually filtering is still visible as a removal chip in
// the main bar, so nothing hides silently.
let SHOW_MORE_FILTERS = false;

// The table's sortable columns, in order. Single source of truth: the header
// row maps over it AND groupHeader derives its colspan from its length, so the
// two can't disagree. The select-all checkbox column is deliberately not here
// — it's hand-written and isn't sortable.
//
// SLA was removed as a column in #447 (it's a per-row flag beside the ID now),
// but t.sla is still read by the KPI tile, the "SLA risk" view chip, the
// breach filter and both CSV exports — dropping the column doesn't drop the
// data.
const TICKET_COLUMNS = [
  ['id','ID'], ['customerId','Customer'], ['subject','Subject'], ['status','Status'],
  ['priority','Priority'], ['category','Category'], ['agent','Agent'], ['updated','Updated'],
];

// Per-row SLA signal, replacing the old SLA column. Only the two states an
// agent must act on get a mark — 'ok' and 'snoozed' render nothing, so the
// column of IDs stays quiet and the marks actually stand out. Solid vs hollow
// triangle, not just colour, so the two are distinguishable without it.
function slaFlag(sla) {
  // role="img" is load-bearing: aria-label is not supported on a bare span
  // (it maps to role=generic) and screen readers drop it, which would leave a
  // breached row with no SLA signal at all now the column is gone.
  if (sla === 'breach') return '<span class="sla-flag sla-breach" role="img" title="SLA breached" aria-label="SLA breached">▲</span>';
  if (sla === 'warn')   return '<span class="sla-flag sla-warn" role="img" title="SLA at risk — approaching breach" aria-label="SLA at risk">△</span>';
  return '';
}

// Saved searches: per-user, persisted server-side. Lazy-load on first
// paint of the list and re-render once the fetch resolves. The
// dropdown lets the agent apply a search in one click; Save current
// turns the current filter state into a new row.
let SAVED_SEARCHES = [];
let SAVED_SEARCHES_LOADED = false;

// Kick off the one-time saved-searches fetch. This used to be a side effect
// of renderSavedSearchesControls(), which was fine while that ran on every
// paint — but the #447 merge moved it inside the "More filters" disclosure,
// so on a fresh load nothing fetched and the PINNED chips (which live in the
// always-visible bar) silently stayed empty. renderTickets calls this now, so
// the fetch no longer depends on which controls happen to be on screen.
// Failure is non-fatal — saved searches are an enhancement, not the page —
// but it shouldn't be permanent either: the flag is set before the request,
// so one transient error used to mean no pinned chips until a full reload.
// Release the flag on failure so a later render retries, capped so a
// consistently-down endpoint can't be re-hit on every render (renderTickets
// runs on each list-sync poll).
const SAVED_SEARCHES_MAX_ATTEMPTS = 3;
let SAVED_SEARCHES_ATTEMPTS = 0;

function ensureSavedSearchesLoaded() {
  if (SAVED_SEARCHES_LOADED || SAVED_SEARCHES_ATTEMPTS >= SAVED_SEARCHES_MAX_ATTEMPTS) return;
  SAVED_SEARCHES_LOADED = true;
  SAVED_SEARCHES_ATTEMPTS++;
  apiGet('/api/v1/saved-searches')
    .then((res) => {
      SAVED_SEARCHES = res.saved_searches || [];
      // A linked ticket may have opened while the list's optional data loaded.
      if (CURRENT_PAGE === 'tickets' && !CURRENT_TICKET) renderPage('tickets');
    })
    .catch((err) => {
      SAVED_SEARCHES_LOADED = false;
      const last = SAVED_SEARCHES_ATTEMPTS >= SAVED_SEARCHES_MAX_ATTEMPTS;
      console.warn(`[tickets] saved searches load failed${last ? ' (giving up)' : ', will retry'}:`, err);
    });
}

function renderSavedSearchesControls() {
  // Group: own searches first, then "Shared with workspace" (via
  // <optgroup>) so the picker reads as a clear two-section list.
  const own    = SAVED_SEARCHES.filter((s) => !s.is_shared || isOwnedByMe(s));
  const shared = SAVED_SEARCHES.filter((s) => s.is_shared && !isOwnedByMe(s));
  const renderOpt = (s) => `<option value="${window.escAttr(s.id)}">${window.escHtml(s.name)}${s.is_shared ? ' (shared)' : ''}</option>`;
  const ownGroup    = own.length    ? `<optgroup label="My searches">${own.map(renderOpt).join('')}</optgroup>` : '';
  const sharedGroup = shared.length ? `<optgroup label="Shared with workspace">${shared.map(renderOpt).join('')}</optgroup>` : '';
  return `
    <select class="filter-select" data-change-action="tickets.applySearchSelect" title="Apply a saved search">
      <option value="">— Saved searches${SAVED_SEARCHES.length ? '' : ' (none yet)'} —</option>
      ${ownGroup}
      ${sharedGroup}
    </select>
    <button class="btn btn-sm" data-action="tickets.saveSearch" title="Save the current filter state">Save current</button>
    ${SAVED_SEARCHES.length ? `<button class="btn btn-sm" data-action="tickets.manageSearches" title="Manage saved searches">Manage</button>` : ''}
  `;
}

function isOwnedByMe(s) {
  return Boolean(SESSION?.userId) && s.user_id === SESSION.userId;
}

// Render pinned saved searches as additional chips on the view row.
// Owner sees their own pinned ones (private or shared); workspace
// members also see anyone's shared+pinned. We deliberately don't
// compute counts per chip — that'd require running the filter
// predicate over the full ticket set per chip and slow the render.
function renderPinnedSavedSearchChips() {
  const pinned = SAVED_SEARCHES.filter((s) => s.is_pinned && (isOwnedByMe(s) || s.is_shared));
  if (pinned.length === 0) return '';
  return pinned.map((s) => {
    const sharedMark = s.is_shared && !isOwnedByMe(s)
      ? ` <span style="font-size:9px;color:var(--ink3);font-weight:400" title="Shared by ${window.escAttr(s.owner_name || 'someone')}">★</span>`
      : '';
    return `<span class="filter-tag filter-tag-saved" style="cursor:pointer" data-action="tickets.applySearch" data-id="${window.escAttr(s.id)}" title="${window.escAttr(s.is_shared ? `Shared by ${s.owner_name || 'someone'}` : 'Pinned saved search')}">${window.escHtml(s.name)}${sharedMark}</span>`;
  }).join('');
}

// "Needs attention" predicate — the union of three urgency signals,
// excluding tickets that are already resolved/closed or currently
// snoozed (the agent has deliberately deferred those). Used by both
// the KPI counter and the view filter so they stay in sync.
function needsAttention(t) {
  if (!isOutstanding(t)) return false;
  const snoozed = t.snoozedUntil && new Date(t.snoozedUntil).getTime() > Date.now();
  if (snoozed) return false;
  return t.sentiment === 'angry'
      || t.sla === 'breach' || t.sla === 'warn'
      || t.priority === 'urgent';
}

// Render hook: applied by renderPage in app.js after innerHTML is set, so
// the table's "select all" checkbox can show the indeterminate state when
// some-but-not-all rows are selected (a DOM property, not an HTML attr).
export function initTicketsPage() {
  const cb = document.getElementById('ticket-select-all-cb');
  if (cb) cb.indeterminate = TICKET_HEADER_CB_INDETERMINATE;
}

export function renderTickets() {
  ensureSavedSearchesLoaded();
  const history = ['history', 'resolved', 'closed'].includes(FILTER_STATUS);
  const scopes = history ? ['outstanding', 'history'] : ['outstanding'];
  for (const scope of scopes) {
    const state = workQueueState(scope);
    // Join an existing badge-started request too; loadWorkQueue shares its promise.
    if (!state.ready && !state.error) void loadWorkQueue(scope).then(() => {
      if (workQueueState(scope) === state && CURRENT_PAGE === 'tickets' && !CURRENT_TICKET) renderPage('tickets');
    });
  }
  const error = scopes.map(s => workQueueState(s).error).find(Boolean);
  if (error || scopes.some(s => !workQueueState(s).ready)) return `<div class="page"><div class="topbar"><div class="tb-title">Tickets</div></div><p class="report-note" role="${error ? 'alert' : 'status'}">${error || 'Loading the complete ticket queue…'}${error ? ' <button class="btn" data-action="tickets.retryQueue">Retry</button>' : ''}</p></div>`;
  refreshQueueUrgency();
  const outstanding = TICKETS.filter(isOutstanding);
  const statuses = history ? ['outstanding', 'history', 'resolved', 'closed'] : ['outstanding','open','pending','escalated','gdpr','history'];
  const tabs = statuses.map(s => {
    const count = s === 'outstanding' ? outstanding.length : s === 'history' ? TICKETS.filter(t => ['resolved', 'closed'].includes(t.status)).length : TICKETS.filter(t => t.status === s).length;
    const label = s === 'history' ? 'History' : s.charAt(0).toUpperCase()+s.slice(1);
    return `<button class="tab ${FILTER_STATUS===s?'active':''}" data-action="tickets.setStatus" data-status="${s}">${label}${s === 'history' && !workQueueState('history').ready ? '' : ` (${count})`}</button>`;
  }).join('');

  const list = getFilteredTickets();
  const groups = groupTicketsBy(list.slice(0, VISIBLE_LIMIT), TICKET_GROUP_BY);
  const cats = [...new Set(TICKETS.map(t => t.category))];
  // How many of the four "More filters" selects are actually narrowing the
  // list. Badged on the toggle so a closed row never hides an active filter.
  // Group-by is excluded on purpose — it rearranges rows, it doesn't drop any.
  const advancedN = [FILTER_CATEGORY, FILTER_PRIORITY, FILTER_AGENT, FILTER_SENTIMENT].filter(v => v !== 'all').length;
  // Chips that carry an × — advanced filters plus the query and the grouping.
  // Drives the separator that divides "views you can pick" from "filters
  // currently applied", since both render as .filter-tag.
  const activeChipN = advancedN + (FILTER_QUERY ? 1 : 0) + (TICKET_GROUP_BY !== 'none' ? 1 : 0);

  // KPIs
  const total = history ? TICKETS.filter(t => ['resolved', 'closed'].includes(t.status)).length : outstanding.length;
  const breachN = outstanding.filter(t => t.sla === 'breach').length;
  const escalatedN = outstanding.filter(t => t.status === 'escalated').length;
  const myN = SESSION ? outstanding.filter(t => t.agent === SESSION.name).length : 0;
  const unassignedN = outstanding.filter(t => !t.agent).length;
  const slaRiskN = outstanding.filter(t => t.sla === 'breach' || t.sla === 'warn').length;

  const snoozedN = outstanding.filter(t => t.snoozedUntil && new Date(t.snoozedUntil).getTime() > Date.now()).length;
  const needsAttentionN = outstanding.filter(needsAttention).length;
  const views = history ? [{ k: 'all', l: 'All history', active: true }] : [
    { k: 'all',             l: 'All',                                 active: FILTER_VIEW === 'all' },
    { k: 'needs_attention', l: `Needs attention · ${needsAttentionN}`, active: FILTER_VIEW === 'needs_attention' },
    { k: 'mine',            l: `Assigned to me · ${myN}`,             active: FILTER_VIEW === 'mine' },
    { k: 'unassigned',      l: `Unassigned · ${unassignedN}`,         active: FILTER_VIEW === 'unassigned' },
    { k: 'breach',          l: `SLA risk · ${slaRiskN}`,              active: FILTER_VIEW === 'breach' },
    { k: 'overdue',         l: `Out of SLA · ${breachN}`,             active: FILTER_VIEW === 'overdue' },
    { k: 'snoozed',         l: `Snoozed · ${snoozedN}`,               active: FILTER_VIEW === 'snoozed' },
  ];

  const rowFor = t => {
    const cust = CUSTOMERS.find(c => c.id === t.customerId);
    const checked = TICKET_SELECTED_IDS.has(t.id);
    return `<tr data-action="tickets.openTicket" data-id="${window.escAttr(t.id)}" style="cursor:pointer${checked?';background:var(--purple-lt)':''}">
      <td style="width:32px;padding-right:0" data-action="">
        <input type="checkbox" ${checked?'checked':''} data-change-action="tickets.toggleSelected" data-id="${window.escAttr(t.id)}" style="cursor:pointer;accent-color:var(--purple)" />
      </td>
      <td class="bold" style="white-space:nowrap">${slaFlag(t.sla)}${window.escHtml(t.id)}${copyButton(t.id, 'ticket number')}</td>
      <td>${window.escHtml(t.customerName || (cust ? cust.first+' '+cust.last : '—'))}</td>
      <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--ink)">${window.escHtml(t.subject)}${t.snoozedUntil && new Date(t.snoozedUntil).getTime() > Date.now() ? ` <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);font-weight:400" title="Snoozed">💤 ${window.escHtml(formatSnoozeUntil(t.snoozedUntil))}</span>` : ''}</td>
      <td><span class="tag tag-${window.escAttr(t.status)}">${window.escHtml(t.status)}</span></td>
      <td><span class="tag tag-${window.escAttr(t.priority)}">${window.escHtml(t.priority)}</span></td>
      <td>${window.escHtml(t.category)}</td>
      <td>${t.agent ? window.escHtml(t.agent) : '<span style="color:var(--ink3)">Unassigned</span>'}</td>
      <td style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${window.escHtml(t.updated)}</td>
    </tr>`;
  };

  // colspan is derived, not literal: it used to be a hardcoded 10 sitting six
  // lines away from the header array it had to agree with, which is exactly
  // the pair that drifts when a column is added or removed. +1 for the
  // select-all checkbox column, which isn't in TICKET_COLUMNS.
  const groupHeader = key => `<tr style="background:var(--off2)"><td colspan="${TICKET_COLUMNS.length + 1}" style="padding:8px 14px;font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--ink3);text-transform:capitalize">${window.escHtml(key)}</td></tr>`;
  const tableBody = groups.map(g => `${g.key !== null ? groupHeader(`${g.key} · ${g.items.length}`) : ''}${g.items.map(rowFor).join('')}`).join('');

  const filteredIds = list.map(t => t.id);
  const allSelected = filteredIds.length > 0 && filteredIds.every(id => TICKET_SELECTED_IDS.has(id));
  const someSelected = !allSelected && filteredIds.some(id => TICKET_SELECTED_IDS.has(id));
  // initTicketsPage reads this and applies the indeterminate DOM property after innerHTML.
  TICKET_HEADER_CB_INDETERMINATE = someSelected;

  const bulkBar = TICKET_SELECTED_IDS.size > 0 ? `
    <div style="padding:8px 20px;border-bottom:1px solid var(--rule);background:var(--purple-lt);display:flex;align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap">
      <span style="font-size:12px;color:var(--purple);font-weight:600">${TICKET_SELECTED_IDS.size} selected</span>
      <button class="btn btn-sm" data-action="tickets.bulkAssign">Assign…</button>
      <select class="filter-select" data-change-action="tickets.bulkStatus">
        <option value="">Set status…</option>
        <option value="open">Open</option>
        <option value="pending">Pending</option>
        <option value="escalated">Escalated</option>
        <option value="resolved">Resolved</option>
        <option value="closed">Close without resolution…</option>
      </select>
      <select class="filter-select" data-change-action="tickets.bulkPriority">
        <option value="">Set priority…</option>
        <option value="urgent">Urgent</option>
        <option value="high">High</option>
        <option value="normal">Normal</option>
        <option value="low">Low</option>
      </select>
      <button class="btn btn-sm" data-action="tickets.bulkTag">Add tag…</button>
      <button class="btn btn-sm" data-action="snooze.bulkSnooze">💤 Snooze…</button>
      <button class="btn btn-sm" data-action="ar.bulkRun">⇄ Run rules</button>
      <select class="filter-select" data-change-action="macros.bulkRun">
        <option value="">Run macro…</option>
        ${MACROS.map(m => `<option value="${window.escAttr(m.id)}">${window.escHtml(m.icon || '⚡')} ${window.escHtml(m.name)}</option>`).join('')}
      </select>
      <button class="btn btn-sm" data-action="tickets.bulkExport">Export selected</button>
      ${window.canDeleteRecords() ? `<button class="btn btn-sm btn-danger" data-action="tickets.bulkDelete">Delete</button>` : ''}
      <button class="btn btn-sm" data-action="tickets.clearSelection" style="margin-left:auto">Clear selection</button>
    </div>` : '';

  return `
    <div class="page ticket-work-page">
      <div class="topbar">
        <div class="tb-title">Tickets</div>
        <button class="btn btn-sm" data-action="tickets.export">Export CSV</button>
        <button class="btn btn-solid btn-sm" data-action="tickets.newTicket">+ New Ticket</button>
      </div>
      <div class="kpi-bar queue-kpis">
        <button class="kpi" data-action="tickets.focusQueue" data-focus="outstanding"><span class="kpi-n">${outstanding.length}</span><span class="kpi-l">Outstanding</span></button>
        <button class="kpi" data-action="tickets.focusQueue" data-focus="overdue"><span class="kpi-n c-red">${breachN}</span><span class="kpi-l">Out of SLA</span></button>
        <button class="kpi" data-action="tickets.focusQueue" data-focus="escalated"><span class="kpi-n c-purple">${escalatedN}</span><span class="kpi-l">Escalated</span></button>
      </div>
      <p class="report-note">All unfinished tickets, including pending and GDPR, regardless of age. Out of SLA and escalated can overlap.
        <button class="btn btn-sm" data-action="tickets.urgencySort" ${SORT_COL === 'urgency' ? 'disabled' : ''}>Urgency first</button>
        <button class="btn btn-sm" data-action="tickets.retryQueue">Refresh</button></p>
      ${bulkBar}
      <div class="tab-bar" aria-label="Ticket status">${tabs}</div>
      ${/* One bar, not two (issue #447). What stays out here is what an agent
             uses constantly — search, the saved views, and a chip for every
             filter currently narrowing the list. The four rarely-touched
             selects moved behind "More filters", which carries a count so a
             collapsed row can never hide an active filter. */''}
      <div class="filter-bar" style="flex-wrap:wrap">
        ${/* The "Search" label became the placeholder to buy back a slot in
             the merged bar, so the input needs an explicit accessible name —
             a placeholder is not one, and it vanishes once you type. */''}
        <input class="filter-select" id="ticket-search" type="search" aria-label="Search tickets" placeholder="Search subject, ID, customer, tag, agent…" style="width:250px" value="${window.escAttr(FILTER_QUERY)}" data-input-action="tickets.setQuery"/>
        ${/* Three kinds of chip share this row, so each group is marked: the
             built-in views are plain .filter-tag, a pinned saved search adds
             .filter-tag-saved, and everything after the separator is an
             active filter with an × on it. */''}
        <span class="filter-label">View</span>
        ${views.map(v => `<span class="filter-tag${v.active?' active':''}" style="cursor:pointer" data-action="tickets.setView" data-view="${window.escAttr(v.k)}">${v.l}</span>`).join('')}
        ${renderPinnedSavedSearchChips()}
        <button class="filter-more${SHOW_MORE_FILTERS?' open':''}" id="tickets-more-toggle" data-action="tickets.toggleMoreFilters"
                aria-expanded="${SHOW_MORE_FILTERS?'true':'false'}" aria-controls="tickets-more-filters">
          More filters${advancedN?` <span class="filter-more-n">${advancedN}</span>`:''} <span class="filter-more-caret" aria-hidden="true">${SHOW_MORE_FILTERS?'▴':'▾'}</span>
        </button>
        ${activeChipN?'<span class="filter-sep" aria-hidden="true"></span>':''}
        ${/* escHtml on every one of these: applySavedSearch writes them
             straight from a saved-search row, and the API validates
             priority/sentiment only as a bounded string — so a shared search
             from another workspace user is untrusted input. */''}
        ${FILTER_CATEGORY!=='all'?`<span class="filter-tag">${window.escHtml(FILTER_CATEGORY)}<span class="rm" data-action="tickets.clearFilter" data-filter="category">×</span></span>`:''}
        ${FILTER_PRIORITY!=='all'?`<span class="filter-tag">${window.escHtml(FILTER_PRIORITY)}<span class="rm" data-action="tickets.clearFilter" data-filter="priority">×</span></span>`:''}
        ${FILTER_AGENT!=='all'?`<span class="filter-tag">${window.escHtml(FILTER_AGENT)}<span class="rm" data-action="tickets.clearFilter" data-filter="agent">×</span></span>`:''}
        ${FILTER_SENTIMENT!=='all'?`<span class="filter-tag">${window.escHtml(FILTER_SENTIMENT)}<span class="rm" data-action="tickets.clearFilter" data-filter="sentiment">×</span></span>`:''}
        ${FILTER_QUERY?`<span class="filter-tag">"${window.escHtml(FILTER_QUERY)}"<span class="rm" data-action="tickets.clearFilter" data-filter="query">×</span></span>`:''}
        ${/* Grouping isn't a filter (it drops no rows, so it's not in the
             badge) but it does visibly restructure the table, and with the
             select tucked away there'd otherwise be nothing on screen naming
             it or undoing it. */''}
        ${TICKET_GROUP_BY!=='none'?`<span class="filter-tag">Grouped by ${window.escHtml(TICKET_GROUP_BY)}<span class="rm" data-action="tickets.clearGroupBy" title="Remove grouping">×</span></span>`:''}
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${total}</span>
        ${/* A CHILD of .filter-bar, not a sibling, and always in the DOM:
             as a sibling it survived the section being collapsed (leaving an
             orphaned row whose toggle was hidden), and rendering it
             conditionally left aria-controls pointing at nothing while
             closed. It is not itself a .filter-bar — collapsible.js indexes
             those positionally for its persisted ids. */''}
        <div class="filter-subbar" id="tickets-more-filters" ${SHOW_MORE_FILTERS?'':'hidden'}>
        <select class="filter-select" data-change-action="tickets.setFilter" data-filter="category">
          <option value="all">All categories</option>
          ${cats.map(c=>`<option value="${window.escAttr(c)}" ${FILTER_CATEGORY===c?'selected':''}>${window.escHtml(c)}</option>`).join('')}
        </select>
        <select class="filter-select" data-change-action="tickets.setFilter" data-filter="priority">
          <option value="all">All priorities</option>
          <option value="urgent" ${FILTER_PRIORITY==='urgent'?'selected':''}>Urgent</option>
          <option value="high" ${FILTER_PRIORITY==='high'?'selected':''}>High</option>
          <option value="normal" ${FILTER_PRIORITY==='normal'?'selected':''}>Normal</option>
          <option value="low" ${FILTER_PRIORITY==='low'?'selected':''}>Low</option>
        </select>
        <select class="filter-select" data-change-action="tickets.setAgent">
          <option value="all">All agents</option>
          ${AGENTS.map(a=>`<option value="${window.escAttr(a.name)}" ${FILTER_AGENT===a.name?'selected':''}>${window.escHtml(a.name)}</option>`).join('')}
        </select>
        <select class="filter-select" data-change-action="tickets.setFilter" data-filter="sentiment" title="Filter by latest customer sentiment">
          <option value="all">All sentiments</option>
          <option value="angry"      ${FILTER_SENTIMENT==='angry'?'selected':''}>Angry</option>
          <option value="frustrated" ${FILTER_SENTIMENT==='frustrated'?'selected':''}>Frustrated</option>
          <option value="neutral"    ${FILTER_SENTIMENT==='neutral'?'selected':''}>Neutral</option>
          <option value="positive"   ${FILTER_SENTIMENT==='positive'?'selected':''}>Positive</option>
        </select>
        <span class="filter-subbar-sep" aria-hidden="true"></span>
        <select class="filter-select" data-change-action="tickets.setGroupBy" title="Group rows">
          <option value="none"     ${TICKET_GROUP_BY==='none'?'selected':''}>No grouping</option>
          <option value="status"   ${TICKET_GROUP_BY==='status'?'selected':''}>Group by status</option>
          <option value="priority" ${TICKET_GROUP_BY==='priority'?'selected':''}>Group by priority</option>
          <option value="category" ${TICKET_GROUP_BY==='category'?'selected':''}>Group by category</option>
          <option value="agent"    ${TICKET_GROUP_BY==='agent'?'selected':''}>Group by agent</option>
        </select>
        <span style="margin-left:auto;display:flex;gap:6px;align-items:center">
          ${renderSavedSearchesControls()}
        </span>
        </div>
      </div>
      <div style="flex:1;overflow-y:auto">
        <table class="tbl">
          <thead><tr>
            <th style="width:32px;padding-right:0" data-action="">
              <input type="checkbox" id="ticket-select-all-cb" ${allSelected?'checked':''} data-change-action="tickets.toggleAll" style="cursor:pointer;accent-color:var(--purple)" title="Select all ${list.length} matching tickets"/>
            </th>
            ${TICKET_COLUMNS.map(([k,l])=>`<th data-action="tickets.sort" data-col="${k}">${l} ${SORT_COL===k?(SORT_DIR===1?'↑':'↓'):''}</th>`).join('')}
          </tr></thead>
          <tbody>${tableBody}</tbody>
        </table>
        ${list.length===0?'<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No tickets match the current filters</div><div class="empty-line"></div></div>':''}
        ${list.length > VISIBLE_LIMIT ? `
          <div style="padding:14px;display:flex;align-items:center;gap:12px;justify-content:center;border-top:1px solid var(--rule)">
            <button class="btn btn-sm" data-action="tickets.loadMore">
              Show more (${Math.min(VISIBLE_LIMIT, list.length)} of ${list.length})
            </button>
          </div>` : ''}
      </div>
    </div>`;
}

function ticketsLoadMore() { VISIBLE_LIMIT += 50; renderPage('tickets'); }

function setStatusFilter(s) { FILTER_STATUS = s; FILTER_VIEW = 'all'; VISIBLE_LIMIT = 50; TICKET_SELECTED_IDS.clear(); renderPage('tickets'); }
function sortTickets(col) {
  if (SORT_COL === col) SORT_DIR *= -1; else { SORT_COL = col; SORT_DIR = 1; }
  renderPage('tickets');
}
function setAgentFilter(v)  { setFilterAgent(v); renderPage('tickets'); }
export function setTicketView(v) { FILTER_VIEW = v; if (v !== 'all') FILTER_STATUS = 'outstanding'; VISIBLE_LIMIT = 50; TICKET_SELECTED_IDS.clear(); renderPage('tickets'); }

// ─── Saved searches ─────────────────────────────────────────────────────

function currentFilterSnapshot() {
  return {
    status:    FILTER_STATUS,
    category:  FILTER_CATEGORY,
    priority:  FILTER_PRIORITY,
    agent:     FILTER_AGENT,
    sentiment: FILTER_SENTIMENT,
    view:      FILTER_VIEW,
    query:     FILTER_QUERY,
  };
}

async function saveCurrentSearch() {
  const name = (prompt('Name this search:') || '').trim();
  if (!name) return;
  try {
    const res = await apiPost('/api/v1/saved-searches', { name, filters: currentFilterSnapshot() });
    SAVED_SEARCHES = [res.saved_search, ...SAVED_SEARCHES];
    renderPage('tickets');
  } catch (err) {
    alert(`Couldn't save: ${err?.message || err}`);
  }
}

function applySavedSearch(id) {
  if (!id) return;
  const s = SAVED_SEARCHES.find((x) => x.id === id);
  if (!s) return;
  const f = s.filters || {};
  FILTER_STATUS    = f.status && f.status !== 'all' ? f.status : 'outstanding';
  setFilterCategory(f.category  || 'all');
  setFilterPriority(f.priority  || 'all');
  setFilterAgent(f.agent     || 'all');
  setFilterSentiment(f.sentiment || 'all');
  FILTER_VIEW      = f.view      || 'all';
  setFilterQuery(f.query     || '');
  renderPage('tickets');
}

function manageSavedSearches() {
  if (SAVED_SEARCHES.length === 0) return;
  const body = SAVED_SEARCHES.map((s) => {
    const owned = isOwnedByMe(s);
    const attribution = s.is_shared && !owned
      ? `<span style="color:var(--ink3)"> · shared by ${window.escHtml(s.owner_name || 'someone')}</span>`
      : (s.is_shared ? '<span style="color:var(--purple)"> · shared with workspace</span>' : '');
    const pinBtn = owned ? `
      <button class="btn btn-sm" data-action="tickets.togglePin" data-id="${window.escAttr(s.id)}" data-pinned="${s.is_pinned ? 'false' : 'true'}" title="${s.is_pinned ? 'Remove from view chips' : 'Pin as a view chip'}">${s.is_pinned ? 'Unpin' : 'Pin'}</button>
    ` : '';
    const shareBtn = owned ? `
      <button class="btn btn-sm" data-action="tickets.toggleShare" data-id="${window.escAttr(s.id)}" data-shared="${s.is_shared ? 'false' : 'true'}" title="${s.is_shared ? 'Stop sharing with workspace' : 'Share with workspace'}">${s.is_shared ? 'Unshare' : 'Share'}</button>
    ` : '';
    const deleteBtn = owned ? `
      <button class="btn btn-sm btn-danger" data-action="tickets.deleteSearch" data-id="${window.escAttr(s.id)}">Delete</button>
    ` : '';
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--rule)">
        <div style="flex:1;min-width:0">
          <div style="font-weight:500;color:var(--ink);font-size:13px">${window.escHtml(s.name)}${attribution}</div>
          <div style="font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(JSON.stringify(s.filters))}</div>
        </div>
        ${pinBtn}
        ${shareBtn}
        ${deleteBtn}
      </div>`;
  }).join('');
  showModal('Saved searches', body, null, null, true);
}

async function toggleSavedSearchShare(id, share) {
  try {
    const res = await apiPatch(`/api/v1/saved-searches/${encodeURIComponent(id)}`, { is_shared: share });
    SAVED_SEARCHES = SAVED_SEARCHES.map((s) => s.id === id ? { ...s, ...res.saved_search } : s);
    renderPage('tickets');
    manageSavedSearches();
  } catch (err) {
    alert(`Couldn't update sharing: ${err?.message || err}`);
  }
}

async function toggleSavedSearchPin(id, pin) {
  try {
    const res = await apiPatch(`/api/v1/saved-searches/${encodeURIComponent(id)}`, { is_pinned: pin });
    SAVED_SEARCHES = SAVED_SEARCHES.map((s) => s.id === id ? { ...s, ...res.saved_search } : s);
    renderPage('tickets');
    manageSavedSearches();
  } catch (err) {
    alert(`Couldn't update pin state: ${err?.message || err}`);
  }
}

async function deleteSavedSearch(id) {
  if (!confirm('Delete this saved search?')) return;
  try {
    await apiDelete(`/api/v1/saved-searches/${encodeURIComponent(id)}`);
    SAVED_SEARCHES = SAVED_SEARCHES.filter((s) => s.id !== id);
    renderPage('tickets');
    // Re-open the manage modal with the row removed, unless we just
    // deleted the last one.
    if (SAVED_SEARCHES.length > 0) manageSavedSearches();
    else closeModal();
  } catch (err) {
    alert(`Couldn't delete: ${err?.message || err}`);
  }
}
function setTicketQuery(q)  {
  // Capture the caret BEFORE the re-render (the input is destroyed and
  // rebuilt). Forcing it to the end broke mid-string editing: typing into
  // "smith" at offset 0 put the next character at the end instead.
  const before = document.getElementById('ticket-search');
  const selStart = before ? before.selectionStart : null;
  const selEnd   = before ? before.selectionEnd   : null;
  setFilterQuery(q);
  renderPage('tickets');
  const input = document.getElementById('ticket-search');
  if (input) {
    input.focus();
    if (selStart !== null) {
      const max = input.value.length;
      input.setSelectionRange(Math.min(selStart, max), Math.min(selEnd, max));
    }
  }
}
function setTicketGroupBy(v) { TICKET_GROUP_BY = v; renderPage('tickets'); }

function getFilteredTickets() {
  const history = ['history', 'resolved', 'closed'].includes(FILTER_STATUS);
  let list = TICKETS.filter(t => !t.mergedInto && !t._mergedIntoUuid && (history ? ['resolved', 'closed'].includes(t.status) : isOutstanding(t)));
  if (FILTER_VIEW === 'mine' && SESSION) list = list.filter(t => t.agent === SESSION.name);
  else if (FILTER_VIEW === 'unassigned') list = list.filter(t => !t.agent);
  else if (FILTER_VIEW === 'overdue')    list = list.filter(t => t.sla === 'breach');
  else if (FILTER_VIEW === 'breach')     list = list.filter(t => t.sla === 'breach' || t.sla === 'warn');
  else if (FILTER_VIEW === 'snoozed')    list = list.filter(t => t.snoozedUntil && new Date(t.snoozedUntil).getTime() > Date.now());
  else if (FILTER_VIEW === 'needs_attention') list = list.filter(needsAttention);
  if (!['all', 'outstanding', 'history'].includes(FILTER_STATUS)) list = list.filter(t => t.status === FILTER_STATUS);
  if (FILTER_CATEGORY !== 'all') list = list.filter(t => t.category === FILTER_CATEGORY);
  if (FILTER_PRIORITY !== 'all') list = list.filter(t => t.priority === FILTER_PRIORITY);
  if (FILTER_AGENT !== 'all')    list = list.filter(t => t.agent === FILTER_AGENT);
  if (FILTER_SENTIMENT !== 'all') list = list.filter(t => t.sentiment === FILTER_SENTIMENT);
  if (FILTER_QUERY.trim()) {
    const q = FILTER_QUERY.toLowerCase();
    list = list.filter(t => {
      const cust = CUSTOMERS.find(c => c.id === t.customerId);
      const custName = t.customerName || (cust ? (cust.first + ' ' + cust.last) : '');
      return t.id.toLowerCase().includes(q)
        || t.subject.toLowerCase().includes(q)
        || (t.tags || []).some(tag => tag.toLowerCase().includes(q))
        || custName.toLowerCase().includes(q)
        || (t.agent || '').toLowerCase().includes(q);
    });
  }
  list.sort((a, b) => {
    if (SORT_COL === 'urgency') return compareUrgency(a, b);
    let av = a[SORT_COL] || '', bv = b[SORT_COL] || '';
    return typeof av === 'string' ? av.localeCompare(bv) * SORT_DIR : (av - bv) * SORT_DIR;
  });
  return list;
}

function groupTicketsBy(list, by) {
  if (by === 'none') return [{ key: null, items: list }];
  const groups = new Map();
  list.forEach(t => {
    const key = (t[by] || '—') + '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  });
  return [...groups.entries()].map(([key, items]) => ({ key, items }));
}

function toggleTicketSelected(id) {
  if (TICKET_SELECTED_IDS.has(id)) TICKET_SELECTED_IDS.delete(id);
  else TICKET_SELECTED_IDS.add(id);
  renderPage('tickets');
}

function toggleAllTickets() {
  const ids = getFilteredTickets().map(t => t.id);
  const allSelected = ids.length > 0 && ids.every(id => TICKET_SELECTED_IDS.has(id));
  if (allSelected) ids.forEach(id => TICKET_SELECTED_IDS.delete(id));
  else ids.forEach(id => TICKET_SELECTED_IDS.add(id));
  renderPage('tickets');
}

function clearTicketSelection() { TICKET_SELECTED_IDS.clear(); renderPage('tickets'); }

let bulkAssignmentBusy = false;
function bulkAssignTickets() {
  if (TICKET_SELECTED_IDS.size === 0) return;
  if (bulkAssignmentBusy) { showToast('Assignments are still saving.', 'info'); return; }
  const jwt = getJwt(), workspace = getWorkspaceId(), session = SESSION;
  const sameContext = () => getJwt() === jwt && getWorkspaceId() === workspace && SESSION === session;
  let pending = [...TICKET_SELECTED_IDS].map(id => {
    const ticket = TICKETS.find(t => t.id === id);
    return { id, _uuid: ticket?._uuid };
  });
  const agents = AGENTS.filter(a => a.active !== false && (!jwt || a.userId))
    .map((a, i) => ({ ...a, key: a.userId || `demo-${i}` }));
  if (!agents.length) { showToast('No active agents are available for assignment.', 'warn'); return; }
  showModal(`Assign ${pending.length} ticket${pending.length===1?'':'s'}`, `
    <div class="form-row"><label class="form-label" for="bulk-agent">Assign to</label>
      <select class="form-input" id="bulk-agent">${agents.map(a => `<option value="${window.escAttr(a.key)}">${window.escHtml(a.name)}${agents.some(other => other.key !== a.key && other.name === a.name) ? ` (${window.escHtml(a.email || a.userId || a.key)})` : ''}${isAgentOOO(a.name) ? ' (OOO)' : ''}</option>`).join('')}</select>
    </div>
    <div id="bulk-assignment-result" role="status" style="font-size:13px;line-height:1.5"></div>
  `, async () => {
    if (bulkAssignmentBusy || !sameContext()) return;
    const select = document.getElementById('bulk-agent');
    const agent = agents.find(a => a.key === select?.value);
    if (!agent) return;
    const status = document.getElementById('bulk-assignment-result');
    const confirm = document.querySelector('#modal-container [data-action="modal.confirm"]');
    const isCurrent = () => sameContext() && select.isConnected;
    bulkAssignmentBusy = true;
    select.disabled = true;
    confirm.disabled = true;
    confirm.textContent = 'Saving…';
    status.textContent = `Saving ${pending.length} assignment${pending.length === 1 ? '' : 's'}…`;
    try {
      const result = await saveBulkAssignments({
        tickets: pending, agentId: agent.key, isCurrent,
        save: (ticket, agentId) => {
          if (!jwt) return Promise.resolve({ ticket: { id: ticket._uuid || ticket.id, assigned_user_id: agentId } });
          if (!ticket._uuid) throw new Error('This ticket is no longer available. Refresh the list.');
          return apiPatch(`/api/v1/tickets/${ticket._uuid}`, { assigned_user_id: agentId });
        },
        onSaved: (ticket, response) => {
          const t = TICKETS.find(t => ticket._uuid ? t._uuid === ticket._uuid : t.id === ticket.id);
          if (t) {
            if (!jwt && t.assignedUserId !== agent.key) logTicketEvent(t.id, 'assign', `Assigned: ${t.agent || 'Unassigned'} → ${agent.name} (bulk)`);
            if (jwt) applySavedActivity(t, response);
            t.agent = agent.name;
            t.assignedUserId = agent.key;
          }
          TICKET_SELECTED_IDS.delete(ticket.id);
        },
      });
      if (!isCurrent()) return;
      pending = result.failed.map(f => f.ticket);
      if (pending.length) {
        status.innerHTML = `${result.saved.length} saved; ${pending.length} failed. Failed tickets remain selected.<ul>${result.failed.map(f => `<li>${window.escHtml(f.ticket.id)}: ${window.escHtml(f.message)}</li>`).join('')}</ul>`;
      } else {
        closeModal();
        showToast(`Assigned ${result.saved.length} ticket${result.saved.length === 1 ? '' : 's'} to ${agent.name}.`, 'success');
      }
    } finally {
      bulkAssignmentBusy = false;
      if (select.isConnected) {
        if (!sameContext()) closeModal();
        else {
          select.disabled = false;
          confirm.disabled = false;
          confirm.textContent = 'Retry failed';
        }
      }
      if (sameContext()) {
        invalidateWorkQueue();
        updateNavBadges();
        if (CURRENT_PAGE === 'tickets' && !CURRENT_TICKET) renderPage('tickets');
      }
    }
  }, 'Assign');
}

async function bulkSetStatus(v) {
  if (!v || TICKET_SELECTED_IDS.size === 0) return;
  if (v === 'closed') {
    showCloseTickets([...TICKET_SELECTED_IDS], (succeeded) => {
      succeeded.forEach(id => TICKET_SELECTED_IDS.delete(id));
      updateNavBadges();
      if (CURRENT_PAGE === 'tickets' && !CURRENT_TICKET) renderPage('tickets');
    });
    return;
  }
  for (const id of [...TICKET_SELECTED_IDS]) {
    await changeTicketStatus(id, v);
    if (TICKETS.find(t => t.id === id)?.status === v) TICKET_SELECTED_IDS.delete(id);
  }
  updateNavBadges();
  renderPage('tickets');
}

function bulkSetPriority(v) { showBulkEdit('priority', v); }

function bulkAddTag() { showBulkEdit('tag'); }

function bulkExportTickets() {
  if (TICKET_SELECTED_IDS.size === 0) return;
  const list = TICKETS.filter(t => TICKET_SELECTED_IDS.has(t.id));
  const headers = ['ID','Customer','Subject','Status','Priority','Category','Agent','Created','Updated','SLA','Tags','CSAT','Time logged','Time billable'];
  const rows = list.map(t => {
    const cust = CUSTOMERS.find(c => c.id === t.customerId);
    return [t.id, cust ? cust.first + ' ' + cust.last : '', t.subject, t.status, t.priority, t.category, t.agent || '', t.created, t.updated, t.sla, (t.tags || []).join(';'), t.csat ?? '', window.fmtMinutes(ticketTotalMinutes(t)), window.fmtMinutes(ticketBillableMinutes(t))];
  });
  const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  // UTF-8 BOM so Excel on Windows recognises the encoding for accented names/tags.
  const blob = new Blob(['﻿' + csv], { type:'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url; a.download = `tickets-selected-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Bulk delete — real, server-persisted. The button only renders for
// canDeleteRecords() holders, and the server re-verifies per ticket (a
// blank ticket would pass for anyone, but bulk is a permission-holder
// surface). Each selected API ticket gets its own DELETE so per-row 403/409
// failures (e.g. a merge primary with live duplicates) are reported without
// aborting the rest; demo rows (no _uuid) keep the in-memory splice.
function bulkDeleteTickets() {
  if (!window.canDeleteRecords()) return;
  const n = TICKET_SELECTED_IDS.size;
  if (n === 0) return;
  showDangerConfirm({
    title: `Delete ${n} ticket${n===1?'':'s'}`,
    bodyHtml: `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${n}</strong> ticket${n===1?'':'s'}? Their full conversation history goes with them. This cannot be undone.</div>`,
    confirmLabel: 'Delete',
    onConfirm: async () => {
      closeModal();
      const ids = [...TICKET_SELECTED_IDS];
      const failures = [];
      for (const id of ids) {
        const t = TICKETS.find(x => x.id === id);
        if (!t) continue;
        if (t._uuid) {
          try { await apiDelete(`/api/v1/tickets/${t._uuid}`); }
          catch (err) { failures.push(`${id}: ${err?.message || err}`); continue; }
        } else {
          // Demo persona — no API; the splice below is the whole delete.
          logTicketEvent(id, 'system', `Ticket deleted (bulk) by ${SESSION?.name || 'system'}`);
        }
        clearAllDrafts(id);
        const i = TICKETS.findIndex(x => x.id === id);
        if (i >= 0) TICKETS.splice(i, 1);
        TICKET_SELECTED_IDS.delete(id);
      }
      TICKET_SELECTED_IDS.clear();
      updateNavBadges();
      renderPage('tickets');
      if (failures.length) {
        showToast(`${ids.length - failures.length} deleted · ${failures.length} could not be deleted (${failures[0]}${failures.length > 1 ? ', …' : ''})`, 'error', 8000);
      }
    },
  });
}

function exportTicketList() {
  const list = getFilteredTickets();
  const headers = ['ID','Customer','Subject','Status','Priority','Category','Agent','Created','Updated','SLA','Tags','CSAT','Time logged','Time billable'];
  const rows = list.map(t => {
    const cust = CUSTOMERS.find(c => c.id === t.customerId);
    return [t.id, cust ? cust.first + ' ' + cust.last : '', t.subject, t.status, t.priority, t.category, t.agent || '', t.created, t.updated, t.sla, (t.tags || []).join(';'), t.csat ?? '', window.fmtMinutes(ticketTotalMinutes(t)), window.fmtMinutes(ticketBillableMinutes(t))];
  });
  const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url; a.download = `tickets-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

registerActions({
  'tickets.retryQueue': () => { invalidateWorkQueue(); renderPage('tickets'); },
  'tickets.urgencySort': () => { SORT_COL = 'urgency'; SORT_DIR = 1; renderPage('tickets'); },
  'tickets.focusQueue': ds => {
    FILTER_STATUS = ds.focus === 'escalated' ? 'escalated' : 'outstanding';
    FILTER_VIEW = ds.focus === 'overdue' ? 'overdue' : 'all';
    setFilterCategory('all'); setFilterPriority('all'); setFilterAgent('all'); setFilterSentiment('all'); setFilterQuery('');
    SORT_COL = 'urgency'; SORT_DIR = 1; VISIBLE_LIMIT = 50; TICKET_SELECTED_IDS.clear();
    renderPage('tickets');
  },
  'tickets.loadMore':      () => ticketsLoadMore(),
  // saved searches
  'tickets.saveSearch':    () => saveCurrentSearch(),
  'tickets.manageSearches':() => manageSavedSearches(),
  'tickets.applySearch':   (ds) => applySavedSearch(ds.id),
  'tickets.togglePin':     (ds) => toggleSavedSearchPin(ds.id, ds.pinned === 'true'),
  'tickets.toggleShare':   (ds) => toggleSavedSearchShare(ds.id, ds.shared === 'true'),
  'tickets.deleteSearch':  (ds) => deleteSavedSearch(ds.id),
  // status tabs / view chips / sort / row open / topbar
  'tickets.setStatus':     (ds) => setStatusFilter(ds.status),
  'tickets.setView':       (ds) => setTicketView(ds.view),
  'tickets.toggleMoreFilters': () => {
    SHOW_MORE_FILTERS = !SHOW_MORE_FILTERS;
    renderPage('tickets');
    // renderPage replaces the whole page, so a keyboard user who pressed
    // Enter on the toggle would land back on <body> and have to tab through
    // the entire shell to reach the row they just opened.
    document.getElementById('tickets-more-toggle')?.focus();
  },
  'tickets.clearGroupBy': () => setTicketGroupBy('none'),
  'tickets.sort':          (ds) => sortTickets(ds.col),
  'tickets.openTicket':    (ds) => openTicket(ds.id),
  'tickets.newTicket':     () => showNewTicketModal(),
  'tickets.export':        () => exportTicketList(),
  // bulk actions
  'tickets.bulkAssign':    () => bulkAssignTickets(),
  'tickets.bulkTag':       () => bulkAddTag(),
  'tickets.bulkExport':    () => bulkExportTickets(),
  'tickets.bulkDelete':    () => bulkDeleteTickets(),
  'tickets.clearSelection':() => clearTicketSelection(),
  // filter chips (clear)
  'tickets.clearFilter':   (ds) => {
    if      (ds.filter === 'category')  setFilterCategory('all');
    else if (ds.filter === 'priority')  setFilterPriority('all');
    else if (ds.filter === 'agent')     setFilterAgent('all');
    else if (ds.filter === 'sentiment') setFilterSentiment('all');
    else if (ds.filter === 'query')     setFilterQuery('');
    renderPage('tickets');
  },
});

registerChangeActions({
  'tickets.applySearchSelect': (ds, el) => { applySavedSearch(el.value); el.value = ''; },
  'tickets.toggleSelected':    (ds) => toggleTicketSelected(ds.id),
  'tickets.toggleAll':         () => toggleAllTickets(),
  'tickets.bulkStatus':        (ds, el) => { const value = el.value; el.value = ''; return bulkSetStatus(value); },
  'tickets.bulkPriority':      (ds, el) => bulkSetPriority(el.value),
  'tickets.setAgent':          (ds, el) => setAgentFilter(el.value),
  'tickets.setGroupBy':        (ds, el) => setTicketGroupBy(el.value),
  // category / priority / sentiment selects (no dedicated setter — assign the global)
  'tickets.setFilter':         (ds, el) => {
    if      (ds.filter === 'category')  setFilterCategory(el.value);
    else if (ds.filter === 'priority')  setFilterPriority(el.value);
    else if (ds.filter === 'sentiment') setFilterSentiment(el.value);
    renderPage('tickets');
  },
});

registerInputActions({
  'tickets.setQuery': (ds, el) => setTicketQuery(el.value),
});
