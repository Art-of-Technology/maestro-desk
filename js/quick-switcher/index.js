// ─── Cmd+K quick switcher ────────────────────────────────────────────────────
// Keyboard-first overlay that fuzzy-matches the query against pages, tickets,
// customers, agents, and KB articles. Up/Down navigate, Enter opens the
// active result, Esc dismisses. Designed to be the fastest path through the
// app for an agent who knows what they're looking for.
//
// The Cmd+K / Ctrl+K trigger lives in app.js's global keydown listener,
// which calls the imported toggleQuickSwitcher(true).
//
// External reaches (interim, via window): escHtml, navTo, openTicket,
// isAgentOOO, SEARCH_PAGES — all still in app.js (SEARCH_PAGES is bridged
// on window so both the quick switcher and global search can read it).
//
// TICKETS, CUSTOMERS, AGENTS, KB_ARTICLES come from data.js via the global
// lexical env; CUSTOMER_SELECTED, AGENT_SELECTED, KB_SELECTED come from
// core/state.js the same way.

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
  const pageDefs = window.SEARCH_PAGES || [];
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
    sub: `${a.role}${window.isAgentOOO?.(a.name) ? ' · OOO' : ''}`,
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
      // flatIdx is a counter integer — safe to inline. Hover updates the
      // active row via class swap (qsSetActive) instead of a full rebuild
      // so DOM thrash on mouse movement is eliminated.
      return `<div class="qs-item ${active?'qs-active':''}" data-idx="${flatIdx}" onclick="quickSwitcherPick(${flatIdx})" onmouseenter="qsSetActive(${flatIdx})">
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
    <div class="qs-backdrop" onclick="toggleQuickSwitcher(false)"></div>
    <div class="qs-shell" role="dialog" aria-label="Quick switcher">
      <div class="qs-head">
        <input id="qs-input" class="qs-input" placeholder="Jump to a ticket, customer, agent, KB article, or page…" value="${window.escHtml(QS_QUERY)}"
               oninput="quickSwitcherInput(this.value)"
               onkeydown="quickSwitcherKey(event)"
               autocomplete="off"/>
        <span class="qs-hint">↑↓ navigate · ↵ open · esc close</span>
      </div>
      <div class="qs-list" id="qs-list">${groupsHtml}${empty}</div>
    </div>`;
}

// Swap the qs-active class without rebuilding the overlay. Called from
// hover (often, fast) and keyboard navigation; cheap class toggles only.
export function qsSetActive(idx) {
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

export function quickSwitcherInput(v) {
  QS_QUERY = v;
  QS_ACTIVE_INDEX = 0;
  QS_RESULTS = quickSwitcherSearch(v);
  renderQuickSwitcher();
}

export function quickSwitcherKey(e) {
  const flat = quickSwitcherFlatItems();
  if (e.key === 'Escape') { e.preventDefault(); toggleQuickSwitcher(false); return; }
  if (!flat.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); qsSetActive((QS_ACTIVE_INDEX + 1) % flat.length); return; }
  if (e.key === 'ArrowUp')   { e.preventDefault(); qsSetActive((QS_ACTIVE_INDEX - 1 + flat.length) % flat.length); return; }
  if (e.key === 'Enter')     { e.preventDefault(); quickSwitcherPick(QS_ACTIVE_INDEX); return; }
}

export function quickSwitcherPick(idx) {
  const item = quickSwitcherFlatItems()[idx];
  if (!item) return;
  toggleQuickSwitcher(false);
  if (item.kind === 'page')          window.navTo(item.payload.page);
  else if (item.kind === 'ticket')   window.openTicket(item.payload.ticketId);
  else if (item.kind === 'customer') { CUSTOMER_SELECTED = item.payload.customerId; window.navTo('customers'); }
  else if (item.kind === 'agent')    { AGENT_SELECTED = item.payload.agentName; window.navTo('agents'); }
  else if (item.kind === 'kb')       { KB_SELECTED = item.payload.kbId; window.navTo('kb'); }
}
