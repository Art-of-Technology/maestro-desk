// ─── Activity log primitives ─────────────────────────────────────────────────
// Every ticket-mutating module (time-tracking, snooze, linked, AI summarize,
// composer reply, status/priority/agent/tag changes, …) writes to the log
// via logTicketEvent(). Entries land on t.events[]; getTicketEvents() reads
// them back with one synthetic "Ticket created" entry appended for tickets
// that have a created date but no explicit creation event.
//
// Lives in core/ rather than tickets/ because it's a sink that crosses
// every feature, and the read side is consumed by the Activity Log page
// which aggregates from tickets + workflows + customer notes.
//
// Click/change/input handlers on the Activity Log page route through
// core/event-delegation.js. No inline `on*=` references remain.
// logTicketEvent, getTicketEvents, renderActivityLog stay exported —
// the first two are reached by ~10 modules via direct ES import, and
// renderActivityLog is called by app.js's router.
//
// SESSION and the page-state vars (ACT_FILTER_ENTITY, ACT_FILTER_TYPE,
// CUSTOMER_SELECTED, WF_SELECTED) come from core/state.js via the
// global lexical env.

import { registerActions, registerChangeActions, registerInputActions } from './event-delegation.js';
import { navTo } from './keybindings.js';
// openTicket is reached via window to avoid an activity-log↔tickets/detail
// import cycle (detail.js imports getTicketEvents from here). detail.js is
// still bridged; this can become a direct import once detail.js migrates.

export function logTicketEvent(ticketId, type, details) {
  const t = TICKETS.find(x => x.id === ticketId);
  if (!t) return;
  if (!t.events) t.events = [];
  t.events.unshift({
    type,
    details,
    author: SESSION?.name || 'System',
    ts: new Date().toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }),
  });
}

export function getTicketEvents(t) {
  const seeded = [];
  if (t.created) seeded.push({ type: 'system', details: 'Ticket created', author: 'System', ts: t.created });
  return (t.events || []).concat(seeded);
}

// ─── Activity log page ───────────────────────────────────────────────────────
// Aggregates events from tickets + workflows + customer notes, sorted newest
// first. ACT_QUERY is page-internal search state; ACT_FILTER_ENTITY and
// ACT_FILTER_TYPE live in state.js because inline `onchange` handlers in the
// filter dropdowns mutate them directly.

let ACT_QUERY = '';

function getAllActivity() {
  const events = [];
  // Ticket events (status, priority, agent, tag, system)
  TICKETS.forEach(t => {
    (t.events || []).forEach(e => {
      events.push({
        ts: e.ts,
        sortKey: e.ts,
        author: e.author || 'System',
        kind: e.type || 'system',          // status / priority / agent / tag / system
        entity: 'ticket',
        entityId: t.id,
        entityName: t.subject,
        details: e.details,
      });
    });
    // Inferred: ticket creation
    if (t.created) {
      events.push({
        ts: t.created,
        sortKey: t.created + ' 00:00',
        author: t.agent || 'System',
        kind: 'created',
        entity: 'ticket',
        entityId: t.id,
        entityName: t.subject,
        details: 'Ticket created',
      });
    }
  });
  // Workflow run history
  WORKFLOWS.forEach(w => (w.history || []).forEach(h => {
    events.push({
      ts: h.ts,
      sortKey: h.ts,
      author: h.triggeredBy || 'System',
      kind: 'workflow',
      entity: 'workflow',
      entityId: w.id,
      entityName: w.name,
      details: `${h.type === 'manual' ? 'Manual run' : 'Triggered run'}${h.ticketId ? ' on ' + h.ticketId : ''}`,
    });
  }));
  // Customer notes
  CUSTOMERS.forEach(c => (c.notes || []).forEach(n => {
    events.push({
      ts: n.ts,
      sortKey: n.ts,
      author: n.author || 'Unknown',
      kind: 'note',
      entity: 'customer',
      entityId: c.id,
      entityName: c.first + ' ' + c.last,
      details: 'Internal note: ' + (n.text || '').slice(0, 80) + ((n.text || '').length > 80 ? '…' : ''),
    });
  }));
  // Sort: newest first by sortKey (string compare works for the common formats we use)
  events.sort((a, b) => (b.sortKey || '').localeCompare(a.sortKey || ''));
  return events;
}

const ACT_KIND_META = {
  status:   { label: 'Status',   color: 'var(--cyan)' },
  priority: { label: 'Priority', color: 'var(--amber)' },
  agent:    { label: 'Agent',    color: 'var(--purple)' },
  tag:      { label: 'Tag',      color: 'var(--green)' },
  workflow: { label: 'Workflow', color: 'var(--purple)' },
  note:     { label: 'Note',     color: 'var(--amber)' },
  created:  { label: 'Created',  color: 'var(--cyan)' },
  system:   { label: 'System',   color: 'var(--ink3)' },
};

function actSetQuery(q) {
  ACT_QUERY = q;
  window.renderPage('activity');
  const input = document.getElementById('act-search');
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

function actGotoEntity(entity, id) {
  if (entity === 'ticket')        window.openTicket(id);
  else if (entity === 'customer') { CUSTOMER_SELECTED = id; navTo('customers'); }
  else if (entity === 'workflow') { WF_SELECTED = id; navTo('workflows'); }
}

export function renderActivityLog() {
  const all = getAllActivity();
  let list = [...all];
  if (ACT_FILTER_TYPE   !== 'all') list = list.filter(e => e.kind   === ACT_FILTER_TYPE);
  if (ACT_FILTER_ENTITY !== 'all') list = list.filter(e => e.entity === ACT_FILTER_ENTITY);
  if (ACT_QUERY.trim()) {
    const q = ACT_QUERY.toLowerCase();
    list = list.filter(e =>
      (e.details||'').toLowerCase().includes(q) ||
      (e.entityName||'').toLowerCase().includes(q) ||
      (e.entityId||'').toLowerCase().includes(q) ||
      (e.author||'').toLowerCase().includes(q)
    );
  }

  const total = all.length;
  const tickets = all.filter(e => e.entity === 'ticket').length;
  const customers = all.filter(e => e.entity === 'customer').length;
  const workflows = all.filter(e => e.entity === 'workflow').length;

  const rows = list.slice(0, 200).map(e => {
    const meta = ACT_KIND_META[e.kind] || ACT_KIND_META.system;
    return `<tr data-action="activity.goto" data-entity="${window.escAttr(e.entity)}" data-entity-id="${window.escAttr(e.entityId)}" style="cursor:pointer">
      <td style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);white-space:nowrap">${window.escHtml(e.ts || '—')}</td>
      <td><span class="tag" style="font-size:10px;border:1px solid ${meta.color}40;color:${meta.color};background:${meta.color}15">${meta.label}</span></td>
      <td><span class="tag tag-neutral" style="font-size:10px;text-transform:capitalize">${window.escHtml(e.entity)}</span></td>
      <td><span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink2)">${window.escHtml(e.entityId)}</span> <span style="font-size:12px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;max-width:200px;vertical-align:bottom">${window.escHtml(e.entityName || '')}</span></td>
      <td style="font-size:12px;color:var(--ink2)">${window.escHtml(e.details || '')}</td>
      <td style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);white-space:nowrap">${window.escHtml(e.author || '')}</td>
    </tr>`;
  }).join('');

  return `
    <div class="page">
      <div class="topbar"><div class="tb-title">Activity Log</div></div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Events</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${tickets}</div><div class="kpi-l">On tickets</div></div>
        <div class="kpi"><div class="kpi-n c-purple">${workflows}</div><div class="kpi-l">Workflow runs</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${customers}</div><div class="kpi-l">Customer notes</div></div>
      </div>
      <div class="filter-bar" style="flex-wrap:wrap">
        <span class="filter-label">Filter</span>
        <input class="filter-select" id="act-search" placeholder="Search events…" style="width:240px" value="${ACT_QUERY}" data-input-action="activity.setQuery"/>
        <select class="filter-select" data-change-action="activity.setFilterEntity">
          <option value="all"      ${ACT_FILTER_ENTITY==='all'?'selected':''}>All entities</option>
          <option value="ticket"   ${ACT_FILTER_ENTITY==='ticket'?'selected':''}>Tickets</option>
          <option value="customer" ${ACT_FILTER_ENTITY==='customer'?'selected':''}>Customers</option>
          <option value="workflow" ${ACT_FILTER_ENTITY==='workflow'?'selected':''}>Workflows</option>
        </select>
        <select class="filter-select" data-change-action="activity.setFilterType">
          <option value="all"      ${ACT_FILTER_TYPE==='all'?'selected':''}>All types</option>
          ${Object.entries(ACT_KIND_META).map(([k, m]) => `<option value="${k}" ${ACT_FILTER_TYPE===k?'selected':''}>${m.label}</option>`).join('')}
        </select>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${total}${list.length>200?` · showing first 200`:''}</span>
      </div>
      <div class="page-scroll">
        <table class="tbl">
          <thead><tr><th style="width:130px">When</th><th>Type</th><th>Entity</th><th>Reference</th><th>Detail</th><th>Author</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${list.length===0 ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No activity events match</div><div class="empty-line"></div></div>` : ''}
        <div style="margin-top:14px;font-size:11px;color:var(--ink3);line-height:1.5">Aggregates events from ticket history (status/priority/agent/tag changes, creation), workflow runs, and customer internal notes. Click a row to jump to the source entity.</div>
      </div>
    </div>`;
}

registerActions({
  'activity.goto': (ds) => actGotoEntity(ds.entity, ds.entityId),
});

registerChangeActions({
  'activity.setFilterEntity': (ds, el) => { ACT_FILTER_ENTITY = el.value; window.renderPage('activity'); },
  'activity.setFilterType':   (ds, el) => { ACT_FILTER_TYPE   = el.value; window.renderPage('activity'); },
});

registerInputActions({
  'activity.setQuery': (ds, el) => actSetQuery(el.value),
});
