// ─── Tickets list ────────────────────────────────────────────────────────────
// The Tickets index page: KPI bar, status tab bar, filter/group/view chips,
// the multi-select bulk-action bar (assign / status / priority / tag / snooze /
// assignment-rules / macro / export / delete), and the sortable, groupable
// ticket table with row checkboxes.
//
// External reaches (interim, via window): escAttr, escHtml, fmtMinutes,
// renderPage, updateNavBadges — all still in app.js. openTicket and the
// bulk-action helpers from sibling tickets/ modules (bulkSnoozeTickets,
// bulkApplyAssignmentRules, bulkRunMacro) and the new-ticket modal entry
// point (showNewTicketModal) are called from inline onclick handlers and
// resolve through window at click time, so they don't need imports here.
//
// TICKETS, CUSTOMERS, AGENTS, TAG_LIBRARY come from data.js via the global
// lexical env; SESSION, TICKET_SELECTED_IDS, FILTER_CATEGORY, FILTER_PRIORITY,
// FILTER_AGENT, FILTER_QUERY come from core/state.js the same way (FILTER_*
// values are written from inline onchange handlers via direct assignment,
// which requires the global lex env binding).

import { MACROS } from './macros.js';
import { formatSnoozeUntil } from './snooze.js';
import { refreshTicketSLA } from './sla.js';
import { isAgentOOO } from './assignment-rules.js';
import { ticketTotalMinutes, ticketBillableMinutes } from './time-tracking.js';
import { logTicketEvent } from '../core/activity-log.js';
import { showModal, closeModal } from '../core/modal.js';
import { loadMoreTickets, ticketsTotal, ticketsLoaded, ticketsHasMore } from '../core/bootstrap.js';
import { registerActions } from '../core/event-delegation.js';

// Module-local filter / sort state. Nothing outside this module reads or
// writes these, so they don't need to live in core/state.js.
let FILTER_STATUS = 'all';
let FILTER_VIEW = 'all';
let TICKET_GROUP_BY = 'none';
let TICKET_HEADER_CB_INDETERMINATE = false;
let SORT_COL = 'id';
let SORT_DIR = 1;

// Render hook: applied by renderPage in app.js after innerHTML is set, so
// the table's "select all" checkbox can show the indeterminate state when
// some-but-not-all rows are selected (a DOM property, not an HTML attr).
export function initTicketsPage() {
  const cb = document.getElementById('ticket-select-all-cb');
  if (cb) cb.indeterminate = TICKET_HEADER_CB_INDETERMINATE;
}

export function renderTickets() {
  const statuses = ['all','open','pending','escalated','gdpr','resolved'];
  const tabs = statuses.map(s => `<div class="tab ${FILTER_STATUS===s?'active':''}" onclick="setStatusFilter('${s}')">${s==='all'?'All':s.charAt(0).toUpperCase()+s.slice(1)}${s!=='all'?' ('+TICKETS.filter(t=>t.status===s).length+')':' ('+TICKETS.length+')'}</div>`).join('');

  const list = getFilteredTickets();
  const groups = groupTicketsBy(list, TICKET_GROUP_BY);
  const cats = [...new Set(TICKETS.map(t => t.category))];

  // KPIs
  const total = TICKETS.length;
  const openN = TICKETS.filter(t => t.status === 'open' || t.status === 'escalated').length;
  const breachN = TICKETS.filter(t => t.sla === 'breach').length;
  const myN = SESSION ? TICKETS.filter(t => t.agent === SESSION.name && (t.status === 'open' || t.status === 'escalated')).length : 0;
  const unassignedN = TICKETS.filter(t => !t.agent).length;
  const slaRiskN = TICKETS.filter(t => t.sla === 'breach' || t.sla === 'warn').length;

  const snoozedN = TICKETS.filter(t => t.snoozedUntil && new Date(t.snoozedUntil).getTime() > Date.now()).length;
  const views = [
    { k: 'all',        l: 'All',                            active: FILTER_VIEW === 'all' },
    { k: 'mine',       l: `Assigned to me · ${myN}`,        active: FILTER_VIEW === 'mine' },
    { k: 'unassigned', l: `Unassigned · ${unassignedN}`,    active: FILTER_VIEW === 'unassigned' },
    { k: 'breach',     l: `SLA risk · ${slaRiskN}`,         active: FILTER_VIEW === 'breach' },
    { k: 'snoozed',    l: `Snoozed · ${snoozedN}`,          active: FILTER_VIEW === 'snoozed' },
  ];

  const rowFor = t => {
    const cust = CUSTOMERS.find(c => c.id === t.customerId);
    const checked = TICKET_SELECTED_IDS.has(t.id);
    return `<tr onclick="openTicket('${window.escAttr(t.id)}')" style="cursor:pointer${checked?';background:var(--purple-lt)':''}">
      <td style="width:32px;padding-right:0" onclick="event.stopPropagation()">
        <input type="checkbox" ${checked?'checked':''} onchange="toggleTicketSelected('${window.escAttr(t.id)}')" style="cursor:pointer;accent-color:var(--purple)" />
      </td>
      <td class="bold">${window.escHtml(t.id)}</td>
      <td>${cust ? window.escHtml(cust.first+' '+cust.last) : '—'}</td>
      <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--ink)">${window.escHtml(t.subject)}${t.snoozedUntil && new Date(t.snoozedUntil).getTime() > Date.now() ? ` <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);font-weight:400" title="Snoozed">💤 ${window.escHtml(formatSnoozeUntil(t.snoozedUntil))}</span>` : ''}</td>
      <td><span class="tag tag-${window.escAttr(t.status)}">${window.escHtml(t.status)}</span></td>
      <td><span class="tag tag-${window.escAttr(t.priority)}">${window.escHtml(t.priority)}</span></td>
      <td>${window.escHtml(t.category)}</td>
      <td>${t.agent ? window.escHtml(t.agent) : '<span style="color:var(--ink3)">Unassigned</span>'}</td>
      <td style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${window.escHtml(t.updated)}</td>
      <td><span class="sla-${window.escAttr(t.sla)}" style="font-family:'Inter',sans-serif;font-size:11px;font-weight:500;text-transform:uppercase">${window.escHtml(t.sla)}</span></td>
    </tr>`;
  };

  const groupHeader = key => `<tr style="background:var(--off2)"><td colspan="10" style="padding:8px 14px;font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--ink3);text-transform:capitalize">${window.escHtml(key)}</td></tr>`;
  const tableBody = groups.map(g => `${g.key !== null ? groupHeader(`${g.key} · ${g.items.length}`) : ''}${g.items.map(rowFor).join('')}`).join('');

  const filteredIds = list.map(t => t.id);
  const allSelected = filteredIds.length > 0 && filteredIds.every(id => TICKET_SELECTED_IDS.has(id));
  const someSelected = !allSelected && filteredIds.some(id => TICKET_SELECTED_IDS.has(id));
  // initTicketsPage reads this and applies the indeterminate DOM property after innerHTML.
  TICKET_HEADER_CB_INDETERMINATE = someSelected;

  const bulkBar = TICKET_SELECTED_IDS.size > 0 ? `
    <div style="padding:8px 20px;border-bottom:1px solid var(--rule);background:var(--purple-lt);display:flex;align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap">
      <span style="font-size:12px;color:var(--purple);font-weight:600">${TICKET_SELECTED_IDS.size} selected</span>
      <button class="btn btn-sm" onclick="bulkAssignTickets()">Assign…</button>
      <select class="filter-select" onchange="bulkSetStatus(this.value)">
        <option value="">Set status…</option>
        <option value="open">Open</option>
        <option value="pending">Pending</option>
        <option value="escalated">Escalated</option>
        <option value="resolved">Resolved</option>
      </select>
      <select class="filter-select" onchange="bulkSetPriority(this.value)">
        <option value="">Set priority…</option>
        <option value="urgent">Urgent</option>
        <option value="high">High</option>
        <option value="normal">Normal</option>
        <option value="low">Low</option>
      </select>
      <button class="btn btn-sm" onclick="bulkAddTag()">Add tag…</button>
      <button class="btn btn-sm" onclick="bulkSnoozeTickets()">💤 Snooze…</button>
      <button class="btn btn-sm" onclick="bulkApplyAssignmentRules()">⇄ Run rules</button>
      <select class="filter-select" onchange="bulkRunMacro(this.value)">
        <option value="">Run macro…</option>
        ${MACROS.map(m => `<option value="${window.escAttr(m.id)}">${window.escHtml(m.icon || '⚡')} ${window.escHtml(m.name)}</option>`).join('')}
      </select>
      <button class="btn btn-sm" onclick="bulkExportTickets()">Export selected</button>
      <button class="btn btn-sm btn-danger" onclick="bulkDeleteTickets()">Delete</button>
      <button class="btn btn-sm" onclick="clearTicketSelection()" style="margin-left:auto">Clear selection</button>
    </div>` : '';

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Tickets</div>
        <button class="btn btn-sm" onclick="exportTicketList()">Export CSV</button>
        <button class="btn btn-solid btn-sm" onclick="showNewTicketModal()">+ New Ticket</button>
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Total</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${openN}</div><div class="kpi-l">Open</div></div>
        <div class="kpi"><div class="kpi-n c-red">${breachN}</div><div class="kpi-l">SLA breach</div></div>
        <div class="kpi"><div class="kpi-n c-purple">${myN}</div><div class="kpi-l">Assigned to me</div></div>
      </div>
      ${bulkBar}
      <div class="tab-bar">${tabs}</div>
      <div class="filter-bar" style="flex-wrap:wrap">
        <span class="filter-label">Search</span>
        <input class="filter-select" id="ticket-search" placeholder="Subject, ID, customer, tag, agent…" style="width:260px" value="${FILTER_QUERY}" oninput="setTicketQuery(this.value)"/>
        <select class="filter-select" onchange="FILTER_CATEGORY=this.value;renderPage('tickets')">
          <option value="all">All categories</option>
          ${cats.map(c=>`<option value="${c}" ${FILTER_CATEGORY===c?'selected':''}>${c}</option>`).join('')}
        </select>
        <select class="filter-select" onchange="FILTER_PRIORITY=this.value;renderPage('tickets')">
          <option value="all">All priorities</option>
          <option value="urgent" ${FILTER_PRIORITY==='urgent'?'selected':''}>Urgent</option>
          <option value="high" ${FILTER_PRIORITY==='high'?'selected':''}>High</option>
          <option value="normal" ${FILTER_PRIORITY==='normal'?'selected':''}>Normal</option>
          <option value="low" ${FILTER_PRIORITY==='low'?'selected':''}>Low</option>
        </select>
        <select class="filter-select" onchange="setAgentFilter(this.value)">
          <option value="all">All agents</option>
          ${AGENTS.map(a=>`<option value="${a.name}" ${FILTER_AGENT===a.name?'selected':''}>${a.name}</option>`).join('')}
        </select>
        <select class="filter-select" onchange="FILTER_SENTIMENT=this.value;renderPage('tickets')" title="Filter by latest customer sentiment">
          <option value="all">All sentiments</option>
          <option value="angry"      ${FILTER_SENTIMENT==='angry'?'selected':''}>Angry</option>
          <option value="frustrated" ${FILTER_SENTIMENT==='frustrated'?'selected':''}>Frustrated</option>
          <option value="neutral"    ${FILTER_SENTIMENT==='neutral'?'selected':''}>Neutral</option>
          <option value="positive"   ${FILTER_SENTIMENT==='positive'?'selected':''}>Positive</option>
        </select>
        <select class="filter-select" onchange="setTicketGroupBy(this.value)" title="Group rows">
          <option value="none"     ${TICKET_GROUP_BY==='none'?'selected':''}>No grouping</option>
          <option value="status"   ${TICKET_GROUP_BY==='status'?'selected':''}>Group by status</option>
          <option value="priority" ${TICKET_GROUP_BY==='priority'?'selected':''}>Group by priority</option>
          <option value="category" ${TICKET_GROUP_BY==='category'?'selected':''}>Group by category</option>
          <option value="agent"    ${TICKET_GROUP_BY==='agent'?'selected':''}>Group by agent</option>
        </select>
        ${FILTER_CATEGORY!=='all'?`<span class="filter-tag">${FILTER_CATEGORY}<span class="rm" onclick="FILTER_CATEGORY='all';renderPage('tickets')">×</span></span>`:''}
        ${FILTER_PRIORITY!=='all'?`<span class="filter-tag">${FILTER_PRIORITY}<span class="rm" onclick="FILTER_PRIORITY='all';renderPage('tickets')">×</span></span>`:''}
        ${FILTER_AGENT!=='all'?`<span class="filter-tag">${FILTER_AGENT}<span class="rm" onclick="FILTER_AGENT='all';renderPage('tickets')">×</span></span>`:''}
        ${FILTER_SENTIMENT!=='all'?`<span class="filter-tag">${FILTER_SENTIMENT}<span class="rm" onclick="FILTER_SENTIMENT='all';renderPage('tickets')">×</span></span>`:''}
        ${FILTER_QUERY?`<span class="filter-tag">"${FILTER_QUERY}"<span class="rm" onclick="FILTER_QUERY='';renderPage('tickets')">×</span></span>`:''}
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${total}</span>
      </div>
      <div class="filter-bar" style="border-top:none;padding-top:6px;padding-bottom:10px">
        <span class="filter-label">View</span>
        ${views.map(v => `<span class="filter-tag" style="cursor:pointer;${v.active?'border-color:var(--purple);color:var(--purple);background:var(--purple-lt)':''}" onclick="setTicketView('${v.k}')">${v.l}</span>`).join('')}
      </div>
      <div style="flex:1;overflow-y:auto">
        <table class="tbl">
          <thead><tr>
            <th style="width:32px;padding-right:0" onclick="event.stopPropagation()">
              <input type="checkbox" id="ticket-select-all-cb" ${allSelected?'checked':''} onchange="toggleAllTickets()" style="cursor:pointer;accent-color:var(--purple)" title="Select all in view"/>
            </th>
            ${[['id','ID'],['customerId','Customer'],['subject','Subject'],['status','Status'],['priority','Priority'],['category','Category'],['agent','Agent'],['updated','Updated'],['sla','SLA']].map(([k,l])=>`<th onclick="sortTickets('${k}')">${l} ${SORT_COL===k?(SORT_DIR===1?'↑':'↓'):''}</th>`).join('')}
          </tr></thead>
          <tbody>${tableBody}</tbody>
        </table>
        ${list.length===0?'<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No tickets match the current filters</div><div class="empty-line"></div></div>':''}
        ${ticketsHasMore() ? `
          <div style="padding:14px;display:flex;align-items:center;gap:12px;justify-content:center;border-top:1px solid var(--rule)">
            <button class="btn btn-sm" data-action="tickets.loadMore" ${TICKETS_LOAD_MORE_PENDING ? 'disabled' : ''}>
              ${TICKETS_LOAD_MORE_PENDING ? 'Loading…' : `Load more (${ticketsLoaded()} of ${ticketsTotal()})`}
            </button>
          </div>` : ''}
      </div>
    </div>`;
}

let TICKETS_LOAD_MORE_PENDING = false;
async function ticketsLoadMore() {
  if (TICKETS_LOAD_MORE_PENDING || !ticketsHasMore()) return;
  TICKETS_LOAD_MORE_PENDING = true;
  window.renderPage('tickets');
  try { await loadMoreTickets(); }
  catch (err) { alert(`Couldn't load more tickets: ${err?.message || err}`); }
  finally {
    TICKETS_LOAD_MORE_PENDING = false;
    window.renderPage('tickets');
  }
}

export function setStatusFilter(s) { FILTER_STATUS = s; window.renderPage('tickets'); }
export function sortTickets(col) {
  if (SORT_COL === col) SORT_DIR *= -1; else { SORT_COL = col; SORT_DIR = 1; }
  window.renderPage('tickets');
}
export function setAgentFilter(v)  { FILTER_AGENT = v; window.renderPage('tickets'); }
export function setTicketView(v)   { FILTER_VIEW = v;  window.renderPage('tickets'); }
export function setTicketQuery(q)  {
  FILTER_QUERY = q;
  window.renderPage('tickets');
  const input = document.getElementById('ticket-search');
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}
export function setTicketGroupBy(v) { TICKET_GROUP_BY = v; window.renderPage('tickets'); }

function getFilteredTickets() {
  let list = [...TICKETS];
  if (FILTER_VIEW === 'mine' && SESSION) list = list.filter(t => t.agent === SESSION.name);
  else if (FILTER_VIEW === 'unassigned') list = list.filter(t => !t.agent);
  else if (FILTER_VIEW === 'breach')     list = list.filter(t => t.sla === 'breach' || t.sla === 'warn');
  else if (FILTER_VIEW === 'snoozed')    list = list.filter(t => t.snoozedUntil && new Date(t.snoozedUntil).getTime() > Date.now());
  if (FILTER_STATUS !== 'all')   list = list.filter(t => t.status === FILTER_STATUS);
  if (FILTER_CATEGORY !== 'all') list = list.filter(t => t.category === FILTER_CATEGORY);
  if (FILTER_PRIORITY !== 'all') list = list.filter(t => t.priority === FILTER_PRIORITY);
  if (FILTER_AGENT !== 'all')    list = list.filter(t => t.agent === FILTER_AGENT);
  if (FILTER_SENTIMENT !== 'all') list = list.filter(t => t.sentiment === FILTER_SENTIMENT);
  if (FILTER_QUERY.trim()) {
    const q = FILTER_QUERY.toLowerCase();
    list = list.filter(t => {
      const cust = CUSTOMERS.find(c => c.id === t.customerId);
      const custName = cust ? (cust.first + ' ' + cust.last) : '';
      return t.id.toLowerCase().includes(q)
        || t.subject.toLowerCase().includes(q)
        || (t.tags || []).some(tag => tag.toLowerCase().includes(q))
        || custName.toLowerCase().includes(q)
        || (t.agent || '').toLowerCase().includes(q);
    });
  }
  list.sort((a, b) => {
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

export function toggleTicketSelected(id) {
  if (TICKET_SELECTED_IDS.has(id)) TICKET_SELECTED_IDS.delete(id);
  else TICKET_SELECTED_IDS.add(id);
  window.renderPage('tickets');
}

export function toggleAllTickets() {
  const ids = getFilteredTickets().map(t => t.id);
  const allSelected = ids.length > 0 && ids.every(id => TICKET_SELECTED_IDS.has(id));
  if (allSelected) ids.forEach(id => TICKET_SELECTED_IDS.delete(id));
  else ids.forEach(id => TICKET_SELECTED_IDS.add(id));
  window.renderPage('tickets');
}

export function clearTicketSelection() { TICKET_SELECTED_IDS.clear(); window.renderPage('tickets'); }

export function bulkAssignTickets() {
  if (TICKET_SELECTED_IDS.size === 0) return;
  showModal(`Assign ${TICKET_SELECTED_IDS.size} ticket${TICKET_SELECTED_IDS.size===1?'':'s'}`, `
    <div class="form-row"><label class="form-label">Assign to</label>
      <select class="form-input" id="bulk-agent">${AGENTS.map(a => `<option value="${window.escAttr(a.name)}">${window.escHtml(a.name)}${isAgentOOO(a.name) ? ' (OOO)' : ''}</option>`).join('')}</select>
    </div>
  `, () => {
    const agent = document.getElementById('bulk-agent').value;
    let changed = 0;
    TICKETS.forEach(t => {
      if (!TICKET_SELECTED_IDS.has(t.id)) return;
      if (t.agent === agent) return;
      logTicketEvent(t.id, 'assign', `Assigned: ${t.agent || 'Unassigned'} → ${agent} (bulk)`);
      t.agent = agent;
      changed++;
    });
    TICKET_SELECTED_IDS.clear();
    closeModal(); window.renderPage('tickets');
  }, 'Assign');
}

export function bulkSetStatus(v) {
  if (!v || TICKET_SELECTED_IDS.size === 0) return;
  TICKETS.forEach(t => {
    if (!TICKET_SELECTED_IDS.has(t.id)) return;
    if (t.status === v) return;
    logTicketEvent(t.id, 'status', `Status: ${t.status} → ${v} (bulk)`);
    t.status = v;
    refreshTicketSLA(t);
    if (v === 'resolved' && !t.csatRequestedAt && !t.csat) {
      t.csatRequestedAt = new Date().toISOString().slice(0, 10);
      logTicketEvent(t.id, 'system', 'CSAT survey sent to customer');
    }
  });
  TICKET_SELECTED_IDS.clear();
  window.updateNavBadges();
  window.renderPage('tickets');
}

export function bulkSetPriority(v) {
  if (!v || TICKET_SELECTED_IDS.size === 0) return;
  TICKETS.forEach(t => {
    if (!TICKET_SELECTED_IDS.has(t.id)) return;
    if (t.priority === v) return;
    logTicketEvent(t.id, 'priority', `Priority: ${t.priority} → ${v} (bulk)`);
    t.priority = v;
    refreshTicketSLA(t);
  });
  TICKET_SELECTED_IDS.clear();
  window.renderPage('tickets');
}

export function bulkAddTag() {
  if (TICKET_SELECTED_IDS.size === 0) return;
  const n = TICKET_SELECTED_IDS.size;
  showModal(`Tag ${n} ticket${n===1?'':'s'}`, `
    <div class="form-row"><label class="form-label">Tag</label>
      <input class="form-input" id="bulk-tag" placeholder="e.g. priority-customer" autocomplete="off"/>
      <div style="font-size:11px;color:var(--ink3);margin-top:4px">Lowercase, hyphenated. Tickets that already have the tag are skipped.</div>
    </div>
  `, () => {
    const raw = document.getElementById('bulk-tag').value;
    const tag = String(raw || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (!tag) { alert('Enter a tag.'); return; }
    let added = 0;
    TICKETS.forEach(t => {
      if (!TICKET_SELECTED_IDS.has(t.id)) return;
      if (!t.tags) t.tags = [];
      if (t.tags.includes(tag)) return;
      t.tags.push(tag);
      logTicketEvent(t.id, 'tag', `Tagged: ${tag} (bulk)`);
      added++;
    });
    if (added > 0) {
      const lib = TAG_LIBRARY.find(x => x.tag === tag);
      if (lib) lib.count += added;
      else TAG_LIBRARY.push({ tag, count: added, type: 'manual', conf: null });
    }
    TICKET_SELECTED_IDS.clear();
    closeModal();
    window.renderPage('tickets');
  }, 'Apply tag');
}

export function bulkExportTickets() {
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

export function bulkDeleteTickets() {
  const n = TICKET_SELECTED_IDS.size;
  if (n === 0) return;
  showModal(`Delete ${n} ticket${n===1?'':'s'}`, `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${n}</strong> ticket${n===1?'':'s'}? This cannot be undone.</div>`, () => {
    const ids = [...TICKET_SELECTED_IDS];
    ids.forEach(id => {
      const t = TICKETS.find(x => x.id === id);
      if (t) logTicketEvent(id, 'system', `Ticket deleted (bulk) by ${SESSION?.name || 'system'}`);
    });
    for (let i = TICKETS.length - 1; i >= 0; i--) {
      if (TICKET_SELECTED_IDS.has(TICKETS[i].id)) TICKETS.splice(i, 1);
    }
    TICKET_SELECTED_IDS.clear();
    closeModal();
    window.updateNavBadges();
    window.renderPage('tickets');
  }, 'Delete');
}

export function exportTicketList() {
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
  'tickets.loadMore': () => ticketsLoadMore(),
});
