// ─── Cmd+K quick switcher ────────────────────────────────────────────────────
// Keyboard-first overlay that fuzzy-matches the query against pages, tickets,
// customers, agents, and KB articles. Up/Down navigate, Enter opens the
// active result, Esc dismisses. Designed to be the fastest path through the
// app for an agent who knows what they're looking for.
//
// The Cmd+K / Ctrl+K trigger lives in core/keybindings.js, which imports
// toggleQuickSwitcher directly. No other module reaches into this one.
//
// Click handlers (pick a row, dismiss via backdrop) route through
// core/event-delegation.js as `data-action="qs.*"`. Input/keydown on the
// text field and mouseenter on each row are wired programmatically after
// renderQuickSwitcher() rebuilds the overlay — too dynamic for delegation,
// not worth a per-event harness extension.
//
// External reaches (interim, via window): escHtml — still in app.js. navTo,
// openTicket, isAgentOOO and SEARCH_PAGES are direct ES imports.
//
// TICKETS, CUSTOMERS, AGENTS, KB_ARTICLES come from data.js via the global
// lexical env; CUSTOMER_SELECTED, AGENT_SELECTED, KB_SELECTED come from
// core/state.js the same way.

import { registerActions } from '../core/event-delegation.js';
import { openTicket } from '../tickets/detail.js';
import { isAgentOOO } from '../tickets/assignment-rules.js';
import { navTo } from '../core/keybindings.js';
import { SEARCH_PAGES } from '../global-search/index.js';

let QS_OPEN = false;
let QS_QUERY = '';
let QS_ACTIVE_INDEX = 0;
let QS_RESULTS = [];

export function toggleQuickSwitcher(open) {
  QS_OPEN = open !== undefined ? !!open : !QS_OPEN;
  if (QS_OPEN) {
    QS_QUERY = '';
    QS_ACTIVE_INDEX = 0;
    QS_RESULTS = quickSwitcherSearch('');
    renderQuickSwitcher();
    setTimeout(() => document.getElementById('qs-input')?.focus(), 0);
  } else {
    const root = document.getElementById('quick-switcher');
    if (root) root.remove();
  }
}

function quickSwitcherSearch(rawQ) {
  const q = (rawQ || '').trim().toLowerCase();
  const pageDefs = SEARCH_PAGES || [];
  // Always show pages so empty query lists the full nav surface.
  const pages = pageDefs.map(p => ({
    kind: 'page', label: p.l, sub: p.p, payload: { page: p.p },
  }));
  if (!q) {
    return [
      { group: 'Pages', items: pages.slice(0, 12) },
    ];
  }
  const match = text => text && String(text).toLowerCase().includes(q);
  const pageHits = pages.filter(p => match(p.label) || match(p.sub));
  const tickets = TICKETS.filter(t => match(t.id) || match(t.subject) || match(t.agent) || (t.tags || []).some(match)).slice(0, 10).map(t => ({
    kind: 'ticket',
    label: t.subject,
    sub: `${t.id} · ${t.status} · ${t.priority}${t.agent ? ' · ' + t.agent : ''}`,
    payload: { ticketId: t.id },
  }));
  const customers = CUSTOMERS.filter(c => match(c.first + ' ' + c.last) || match(c.id) || match(c.email) || match(c.brand)).slice(0, 8).map(c => ({
    kind: 'customer',
    label: `${c.first} ${c.last}`,
    sub: `${c.id} · ${c.brand || ''} · ${c.email || ''}`.replace(/\s·\s$/, ''),
    payload: { customerId: c.id },
  }));
  const agents = AGENTS.filter(a => match(a.name) || match(a.role)).slice(0, 6).map(a => ({
    kind: 'agent',
    label: a.name,
    sub: `${a.role}${isAgentOOO(a.name) ? ' · OOO' : ''}`,
    payload: { agentName: a.name },
  }));
  const kbs = KB_ARTICLES.filter(a => match(a.title) || match(a.category)).slice(0, 6).map(a => ({
    kind: 'kb',
    label: a.title,
    sub: `${a.category} · ${a.id}`,
    payload: { kbId: a.id },
  }));
  return [
    pageHits.length    ? { group: 'Pages',     items: pageHits } : null,
    tickets.length     ? { group: 'Tickets',   items: tickets }  : null,
    customers.length   ? { group: 'Customers', items: customers } : null,
    agents.length      ? { group: 'Agents',    items: agents }   : null,
    kbs.length         ? { group: 'KB',        items: kbs }      : null,
  ].filter(Boolean);
}

function quickSwitcherFlatItems() {
  return QS_RESULTS.flatMap(g => g.items);
}

function renderQuickSwitcher() {
  let root = document.getElementById('quick-switcher');
  if (!root) {
    root = document.createElement('div');
    root.id = 'quick-switcher';
    document.body.appendChild(root);
  }
  const flat = quickSwitcherFlatItems();
  if (QS_ACTIVE_INDEX >= flat.length) QS_ACTIVE_INDEX = Math.max(0, flat.length - 1);
  let flatIdx = -1;
  const groupsHtml = QS_RESULTS.map(g => `
    <div class="qs-group">${window.escHtml(g.group)}</div>
    ${g.items.map(item => {
      flatIdx++;
      const active = flatIdx === QS_ACTIVE_INDEX;
      const icon = { page:'⌘', ticket:'⊕', customer:'☻', agent:'★', kb:'⚙' }[item.kind] || '·';
      return `<div class="qs-item ${active?'qs-active':''}" data-idx="${flatIdx}" data-action="qs.pick">
        <span class="qs-kind">${icon}</span>
        <span class="qs-text">
          <span class="qs-label">${window.escHtml(item.label)}</span>
          <span class="qs-sub">${window.escHtml(item.sub || '')}</span>
        </span>
        <span class="qs-go">${active ? '↵' : ''}</span>
      </div>`;
    }).join('')}
  `).join('');
  const empty = flat.length === 0 ? `<div class="qs-empty">No matches. Try different keywords.</div>` : '';
  root.innerHTML = `
    <div class="qs-backdrop" data-action="qs.close"></div>
    <div class="qs-shell" role="dialog" aria-label="Quick switcher">
      <div class="qs-head">
        <input id="qs-input" class="qs-input" placeholder="Jump to a ticket, customer, agent, KB article, or page…" value="${window.escHtml(QS_QUERY)}" autocomplete="off"/>
        <span class="qs-hint">↑↓ navigate · ↵ open · esc close</span>
      </div>
      <div class="qs-list" id="qs-list">${groupsHtml}${empty}</div>
    </div>`;

  // Wire the events that don't go through data-action delegation:
  //  - input/keydown on the single text field
  //  - mouseenter on each row (non-bubbling; cheaper to bind per-row than
  //    delegate via mouseover with target-walking)
  const input = root.querySelector('#qs-input');
  if (input) {
    input.addEventListener('input', e => quickSwitcherInput(e.target.value));
    input.addEventListener('keydown', quickSwitcherKey);
  }
  root.querySelectorAll('.qs-item').forEach((el, i) => {
    el.addEventListener('mouseenter', () => qsSetActive(i));
  });
}

// Swap the qs-active class without rebuilding the overlay. Called from
// hover (often, fast) and keyboard navigation; cheap class toggles only.
function qsSetActive(idx) {
  QS_ACTIVE_INDEX = idx;
  const items = document.querySelectorAll('#quick-switcher .qs-item');
  items.forEach((el, i) => {
    const active = i === idx;
    el.classList.toggle('qs-active', active);
    const go = el.querySelector('.qs-go');
    if (go) go.textContent = active ? '↵' : '';
  });
  // Keep the active row visible when arrow-keying through a long list.
  const active = items[idx];
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function quickSwitcherInput(v) {
  QS_QUERY = v;
  QS_ACTIVE_INDEX = 0;
  QS_RESULTS = quickSwitcherSearch(v);
  renderQuickSwitcher();
}

function quickSwitcherKey(e) {
  const flat = quickSwitcherFlatItems();
  if (e.key === 'Escape') { e.preventDefault(); toggleQuickSwitcher(false); return; }
  if (!flat.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); qsSetActive((QS_ACTIVE_INDEX + 1) % flat.length); return; }
  if (e.key === 'ArrowUp')   { e.preventDefault(); qsSetActive((QS_ACTIVE_INDEX - 1 + flat.length) % flat.length); return; }
  if (e.key === 'Enter')     { e.preventDefault(); quickSwitcherPick(QS_ACTIVE_INDEX); return; }
}

function quickSwitcherPick(idx) {
  const item = quickSwitcherFlatItems()[idx];
  if (!item) return;
  toggleQuickSwitcher(false);
  if (item.kind === 'page')          navTo(item.payload.page);
  else if (item.kind === 'ticket')   openTicket(item.payload.ticketId);
  else if (item.kind === 'customer') { CUSTOMER_SELECTED = item.payload.customerId; navTo('customers'); }
  else if (item.kind === 'agent')    { AGENT_SELECTED = item.payload.agentName; navTo('agents'); }
  else if (item.kind === 'kb')       { KB_SELECTED = item.payload.kbId; navTo('kb'); }
}

registerActions({
  'qs.pick':  (ds) => quickSwitcherPick(parseInt(ds.idx, 10)),
  'qs.close': () => toggleQuickSwitcher(false),
});
