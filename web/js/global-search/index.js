// ─── Global search ───────────────────────────────────────────────────────────
// Two surfaces share the same search:
//
//   1. The top-bar dropdown (#gs-input + #gs-results) — grouped previews of
//      up to a few matches per kind, keyboard navigable, click or Enter to
//      open. "See all results" deep-links to the full Search page.
//
//   2. The full Search Results page (renderSearchResults) — unbounded
//      counts per group with kind-filter chips.
//
// SEARCH_PAGES is the nav lookup table — the static list of pages the
// search surfaces can jump to. It's also consumed by quick-switcher via a
// direct ES import.
//
// External reaches (interim, via window): escHtml, escAttr —
// all still in app.js. navTo and openTicket are direct ES imports.
//
// The page's own inline on*= handlers are delegated as gs.* actions (bottom
// of file). The top-bar search input (#gs-input) is wired programmatically by
// initGlobalSearchInput() (called from app.js); globalSearch / gsKey / gsGo /
// gsOpenAllResults / searchPageSetQuery are module-internal. renderSearchResults
// is the router entry; SEARCH_PAGES is imported by quick-switcher.

import { AGENTS, CUSTOMERS, KB_ARTICLES, TAG_LIBRARY, TICKETS } from '../core/data.js';
import { SEARCH_PAGE_FILTER, setAgentSelected, setCustomerSelected, setKbSelected, setRolesViewAgents, setSearchPageFilter, setTagSelected } from '../core/state.js';
import { nav, renderPage } from '../core/router.js';
import { navTo } from '../core/keybindings.js';
import { openTicket } from '../tickets/detail.js';
import { openCustomerModal } from '../customers/modals.js';
import {
  registerActions, registerMousedownActions, registerInputActions,
} from '../core/event-delegation.js';

export const SEARCH_PAGES = [
  {p:'dashboard', l:'Dashboard'},
  {p:'tickets',   l:'Conversations'},
  {p:'tickets',   l:'Tickets'},
  {p:'inbox',     l:'Inbox'},
  {p:'customers', l:'Customers'},
  {p:'reports',   l:'Insights'},
  {p:'reports',   l:'Reports'},
  {p:'agents',    l:'Agents'},
  {p:'ai',        l:'AI Intelligence'},
  {p:'kb',        l:'Knowledge Base'},
  {p:'tags',      l:'Tags'},
  {p:'roles',     l:'Roles & Permissions'},
  {p:'sla',       l:'SLA Policies'},
  {p:'business-hours', l:'Business Hours'},
  {p:'assignment-rules', l:'Assignment Rules'},
  {p:'csat',      l:'CSAT Surveys'},
  {p:'templates', l:'Response Templates'},
  {p:'macros',    l:'Macros'},
  {p:'ticket-templates', l:'Ticket Templates'},
  {p:'custom-fields', l:'Custom Fields'},
  {p:'layouts',   l:'Layouts'},
  {p:'activity',  l:'Activity Log'},
  {p:'portal',    l:'Customer Portal'},
  {p:'channels',  l:'Channels'},
  {p:'webhooks',  l:'Webhooks'},
  {p:'settings',  l:'Settings'},
  {p:'help',          l:'Help & Support'},
  {p:'notifications', l:'Notifications'},
  {p:'profile',       l:'My profile'},
];

let SEARCH_PAGE_QUERY = '';

function globalSearch(q) {
  const results = document.getElementById('gs-results');
  if (!results) return;
  const ql = (q || '').toLowerCase().trim();
  if (!ql) { results.classList.remove('show'); results.innerHTML = ''; return; }

  const tickets = TICKETS.filter(t => {
    const cust = CUSTOMERS.find(c => c.id === t.customerId);
    const custName = cust ? (cust.first + ' ' + cust.last) : '';
    return t.id.toLowerCase().includes(ql)
      || t.subject.toLowerCase().includes(ql)
      || (t.tags || []).some(tag => tag.toLowerCase().includes(ql))
      || custName.toLowerCase().includes(ql)
      || (t.agent || '').toLowerCase().includes(ql);
  }).slice(0, 6);

  const customers = CUSTOMERS.filter(c =>
    c.id.toLowerCase().includes(ql)
    || (c.first + ' ' + c.last).toLowerCase().includes(ql)
    || c.username.toLowerCase().includes(ql)
    || c.email.toLowerCase().includes(ql)
    || c.brand.toLowerCase().includes(ql)
  ).slice(0, 5);

  const agents = AGENTS.filter(a =>
    a.name.toLowerCase().includes(ql) || a.role.toLowerCase().includes(ql)
  ).slice(0, 5);

  const articles = KB_ARTICLES.filter(a =>
    a.title.toLowerCase().includes(ql)
    || a.body.toLowerCase().includes(ql)
    || a.category.toLowerCase().includes(ql)
    || a.id.toLowerCase().includes(ql)
  ).slice(0, 5);

  const pages = SEARCH_PAGES.filter(pg => pg.l.toLowerCase().includes(ql));

  let html = '';
  if (tickets.length) {
    html += '<div class="gs-group">Tickets</div>';
    html += tickets.map(t => {
      const cust = CUSTOMERS.find(c => c.id === t.customerId);
      const meta = cust ? `${cust.first} ${cust.last}` : '—';
      return `<div class="gs-result" data-mousedown-action="gs.go" data-type="ticket" data-ref="${window.escAttr(t.id)}"><span class="gs-result-type">${t.id}</span><span class="gs-result-main">${t.subject}</span><span class="gs-result-meta">${meta}</span></div>`;
    }).join('');
  }
  if (customers.length) {
    html += '<div class="gs-group">Customers</div>';
    html += customers.map(c => `<div class="gs-result" data-mousedown-action="gs.go" data-type="customer" data-ref="${window.escAttr(c.id)}"><span class="gs-result-type">${c.id}</span><span class="gs-result-main">${c.first} ${c.last}</span><span class="gs-result-meta">${c.email}</span></div>`).join('');
  }
  if (agents.length) {
    html += '<div class="gs-group">Agents</div>';
    html += agents.map(a => `<div class="gs-result" data-mousedown-action="gs.go" data-type="agent" data-ref="${window.escAttr(a.name)}"><span class="gs-result-type">${a.role}</span><span class="gs-result-main">${a.name}</span><span class="gs-result-meta">${a.active?'Active':'Deactivated'}</span></div>`).join('');
  }
  if (articles.length) {
    html += '<div class="gs-group">Knowledge Base</div>';
    html += articles.map(a => `<div class="gs-result" data-mousedown-action="gs.go" data-type="article" data-ref="${window.escAttr(a.id)}"><span class="gs-result-type">${a.id}</span><span class="gs-result-main">${a.title}</span><span class="gs-result-meta">${a.category}</span></div>`).join('');
  }
  if (pages.length) {
    html += '<div class="gs-group">Pages</div>';
    html += pages.map(pg => `<div class="gs-result" data-mousedown-action="gs.go" data-type="page" data-ref="${window.escAttr(pg.p)}"><span class="gs-result-type">Page</span><span class="gs-result-main">${pg.l}</span><span class="gs-result-meta"></span></div>`).join('');
  }
  if (!html) html = `<div class="gs-empty">No matches for "<strong style="color:var(--ink2)">${window.escHtml(q)}</strong>"</div>`;
  else html += `<div style="padding:9px 14px;border-top:1px solid var(--rule);text-align:center;background:var(--off2);position:sticky;bottom:0"><span class="link" data-mousedown-action="gs.openAll" data-q="${window.escAttr(q)}" style="font-size:11px;font-weight:500">See all results for "${window.escHtml(q)}" →</span></div>`;

  results.innerHTML = html;
  results.classList.add('show');
}

function gsGo(type, id) {
  const input = document.getElementById('gs-input');
  const results = document.getElementById('gs-results');
  if (input) input.value = '';
  if (results) { results.classList.remove('show'); results.innerHTML = ''; }
  if (input) input.blur();

  if (type === 'ticket') openTicket(id);
  else if (type === 'customer') openCustomerModal(id);
  else if (type === 'article') {
    setKbSelected(id);
    nav('kb');
  }
  else if (type === 'agent') {
    const a = AGENTS.find(x => x.name === id);
    if (!a) return;
    setRolesViewAgents(a.role);
    nav('roles');
  }
  else if (type === 'page') {
    nav(id);
  }
}

function gsKey(e) {
  const results = document.getElementById('gs-results');
  if (!results || !results.classList.contains('show')) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  const items = results.querySelectorAll('.gs-result');
  if (e.key === 'Escape') { e.preventDefault(); results.classList.remove('show'); return; }
  if (!items.length) return;
  let active = results.querySelector('.gs-result.active');
  let idx = active ? [...items].indexOf(active) : -1;
  if (e.key === 'ArrowDown')      { e.preventDefault(); idx = Math.min(items.length - 1, idx + 1); }
  else if (e.key === 'ArrowUp')   { e.preventDefault(); idx = Math.max(0, idx - 1); }
  else if (e.key === 'Enter')     {
    e.preventDefault();
    if (idx >= 0) items[idx].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    else { gsOpenAllResults(e.target.value); }
    return;
  }
  else return;
  items.forEach(i => i.classList.remove('active'));
  items[idx].classList.add('active');
  items[idx].scrollIntoView({ block: 'nearest' });
}

function gsOpenAllResults(q) {
  const trimmed = (q || '').trim();
  if (!trimmed) return;
  const input = document.getElementById('gs-input');
  const dd = document.getElementById('gs-results');
  if (input) input.value = '';
  if (dd) { dd.classList.remove('show'); dd.innerHTML = ''; }
  SEARCH_PAGE_QUERY = trimmed;
  navTo('search');
}

export function renderSearchResults() {
  const ql = SEARCH_PAGE_QUERY.toLowerCase().trim();
  const tickets = ql ? TICKETS.filter(t => {
    const cust = CUSTOMERS.find(c => c.id === t.customerId);
    const custName = cust ? (cust.first + ' ' + cust.last) : '';
    return t.id.toLowerCase().includes(ql)
      || t.subject.toLowerCase().includes(ql)
      || (t.tags || []).some(tag => tag.toLowerCase().includes(ql))
      || custName.toLowerCase().includes(ql)
      || (t.agent || '').toLowerCase().includes(ql);
  }) : [];
  const customers = ql ? CUSTOMERS.filter(c =>
    c.id.toLowerCase().includes(ql)
    || (c.first + ' ' + c.last).toLowerCase().includes(ql)
    || c.username.toLowerCase().includes(ql)
    || c.email.toLowerCase().includes(ql)
    || c.brand.toLowerCase().includes(ql)
  ) : [];
  const agents = ql ? AGENTS.filter(a => a.name.toLowerCase().includes(ql) || a.role.toLowerCase().includes(ql)) : [];
  const articles = ql ? KB_ARTICLES.filter(a =>
    a.title.toLowerCase().includes(ql)
    || a.body.toLowerCase().includes(ql)
    || a.category.toLowerCase().includes(ql)
    || a.id.toLowerCase().includes(ql)
  ) : [];
  const tags = ql ? TAG_LIBRARY.filter(t => t.tag.toLowerCase().includes(ql)) : [];
  const pages = ql ? SEARCH_PAGES.filter(pg => pg.l.toLowerCase().includes(ql)) : [];

  const counts = {
    tickets: tickets.length,
    customers: customers.length,
    agents: agents.length,
    articles: articles.length,
    tags: tags.length,
    pages: pages.length,
  };
  const totalCount = Object.values(counts).reduce((s, n) => s + n, 0);

  const filters = [
    { k: 'all',       l: `All · ${totalCount}` },
    { k: 'tickets',   l: `Tickets · ${counts.tickets}` },
    { k: 'customers', l: `Customers · ${counts.customers}` },
    { k: 'agents',    l: `Agents · ${counts.agents}` },
    { k: 'articles',  l: `KB · ${counts.articles}` },
    { k: 'tags',      l: `Tags · ${counts.tags}` },
    { k: 'pages',     l: `Pages · ${counts.pages}` },
  ];

  const showSection = (k) => SEARCH_PAGE_FILTER === 'all' || SEARCH_PAGE_FILTER === k;

  const sectionHtml = (title, items, body) => items.length ? `
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div class="card-title" style="margin:0">${title}</div>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3)">${items.length} match${items.length===1?'':'es'}</span>
      </div>
      ${body}
    </div>` : '';

  const ticketsHtml = sectionHtml('Tickets', tickets, `
    <div style="display:flex;flex-direction:column;gap:5px">
      ${tickets.slice(0, 50).map(t => {
        const cust = CUSTOMERS.find(c => c.id === t.customerId);
        return `<div data-action="gs.openTicket" data-id="${window.escAttr(t.id)}" style="padding:9px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;display:flex;gap:10px;align-items:center;background:var(--off2);transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
          <span class="tag tag-${t.status}" style="font-size:9px">${t.status}</span>
          <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);flex-shrink:0">${t.id}</span>
          <span style="flex:1;font-size:12.5px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(t.subject)}</span>
          <span style="font-size:11px;color:var(--ink3);flex-shrink:0">${cust ? window.escHtml(cust.first + ' ' + cust.last) : '—'}</span>
        </div>`;
      }).join('')}
    </div>`);

  const customersHtml = sectionHtml('Customers', customers, `
    <div style="display:flex;flex-direction:column;gap:5px">
      ${customers.slice(0, 50).map(c => `<div data-action="gs.openCustomer" data-id="${window.escAttr(c.id)}" style="padding:9px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;display:flex;gap:10px;align-items:center;background:var(--off2);transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
        <div style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:#fff;flex-shrink:0">${(c.first||'').charAt(0)}${(c.last||'').charAt(0)}</div>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);flex-shrink:0">${c.id}</span>
        <span style="flex:1;font-size:12.5px;color:var(--ink);font-weight:500">${window.escHtml(c.first + ' ' + c.last)}</span>
        <span class="vip-badge vip-${c.vip.toLowerCase()}" style="flex-shrink:0">${c.vip}</span>
        <span style="font-size:11px;color:var(--ink3);flex-shrink:0">${window.escHtml(c.email)}</span>
      </div>`).join('')}
    </div>`);

  const agentsHtml = sectionHtml('Agents', agents, `
    <div style="display:flex;flex-direction:column;gap:5px">
      ${agents.slice(0, 50).map(a => `<div data-action="gs.openAgent" data-name="${window.escAttr(a.name)}" style="padding:9px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;display:flex;gap:10px;align-items:center;background:var(--off2);transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
        <div style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:#fff;flex-shrink:0">${a.initials}</div>
        <span style="flex:1;font-size:12.5px;color:var(--ink);font-weight:500">${window.escHtml(a.name)}</span>
        <span class="tag tag-neutral" style="font-size:10px">${window.escHtml(a.role)}</span>
        <span class="tag ${a.active?'tag-resolved':'tag-gdpr'}" style="font-size:10px">${a.active?'Active':'Off'}</span>
      </div>`).join('')}
    </div>`);

  const articlesHtml = sectionHtml('Knowledge Base', articles, `
    <div style="display:flex;flex-direction:column;gap:5px">
      ${articles.slice(0, 50).map(a => `<div data-action="gs.openKB" data-id="${window.escAttr(a.id)}" style="padding:9px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;display:flex;gap:10px;align-items:center;background:var(--off2);transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);flex-shrink:0">${a.id}</span>
        <span style="flex:1;font-size:12.5px;color:var(--ink);font-weight:500">${window.escHtml(a.title)}</span>
        <span class="tag tag-neutral" style="font-size:10px">${window.escHtml(a.category)}</span>
      </div>`).join('')}
    </div>`);

  const tagsHtml = sectionHtml('Tags', tags, `
    <div style="display:flex;flex-wrap:wrap;gap:6px">
      ${tags.slice(0, 50).map(t => `<span data-action="gs.openTag" data-tag="${window.escAttr(t.tag)}" class="tag tag-neutral" style="font-size:11px;cursor:pointer;display:inline-flex;align-items:center;gap:5px">${window.escHtml(t.tag)}<span style="color:var(--ink3);font-family:'DM Mono',monospace">${t.count}</span></span>`).join('')}
    </div>`);

  const pagesHtml = sectionHtml('Pages', pages, `
    <div style="display:flex;flex-direction:column;gap:5px">
      ${pages.map(pg => `<div data-action="gs.nav" data-page="${window.escAttr(pg.p)}" style="padding:9px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;display:flex;gap:10px;align-items:center;background:var(--off2);transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
        <span class="tag tag-neutral" style="font-size:10px">Page</span>
        <span style="flex:1;font-size:12.5px;color:var(--ink);font-weight:500">${window.escHtml(pg.l)}</span>
      </div>`).join('')}
    </div>`);

  const body = ql
    ? (totalCount === 0
        ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No matches for "${window.escHtml(SEARCH_PAGE_QUERY)}"</div><div class="empty-line"></div></div>`
        : `${showSection('tickets')   ? ticketsHtml   : ''}
           ${showSection('customers') ? customersHtml : ''}
           ${showSection('agents')    ? agentsHtml    : ''}
           ${showSection('articles')  ? articlesHtml  : ''}
           ${showSection('tags')      ? tagsHtml      : ''}
           ${showSection('pages')     ? pagesHtml     : ''}`)
    : `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">Type a query to search</div><div class="empty-line"></div></div>`;

  return `
    <div class="page">
      <div class="topbar"><div class="tb-title">Search</div></div>
      <div class="filter-bar" style="gap:10px">
        <input class="filter-select" id="search-page-input" placeholder="Search across the workspace…" style="flex:1;max-width:520px" value="${window.escHtml(SEARCH_PAGE_QUERY)}" data-input-action="gs.setQuery" autofocus/>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3)">${ql ? `${totalCount} result${totalCount===1?'':'s'}` : ''}</span>
      </div>
      ${ql ? `<div class="filter-bar" style="border-top:none;padding-top:6px;padding-bottom:10px">
        <span class="filter-label">View</span>
        ${filters.map(f => `<span class="filter-tag" style="cursor:pointer;${SEARCH_PAGE_FILTER===f.k?'border-color:var(--purple);color:var(--purple);background:var(--purple-lt)':''}" data-action="gs.setFilter" data-filter="${window.escAttr(f.k)}">${f.l}</span>`).join('')}
      </div>` : ''}
      <div class="page-scroll">${body}</div>
    </div>`;
}

function searchPageSetQuery(q) {
  SEARCH_PAGE_QUERY = q;
  renderPage('search');
  const input = document.getElementById('search-page-input');
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

// Search-results page actions. The top-bar dropdown items use mousedown
// (fire before the #gs-input blur dismisses the dropdown); gsKey dispatches a
// bubbling mousedown on Enter so it reaches this delegated handler.
registerActions({
  'gs.openTicket':   (ds) => openTicket(ds.id),
  'gs.openCustomer': (ds) => { setCustomerSelected(ds.id);   navTo('customers'); },
  'gs.openAgent':    (ds) => { setAgentSelected(ds.name);    navTo('agents'); },
  'gs.openKB':       (ds) => { setKbSelected(ds.id);         navTo('kb'); },
  'gs.openTag':      (ds) => { setTagSelected(ds.tag);       navTo('tags'); },
  'gs.nav':          (ds) => navTo(ds.page),
  'gs.setFilter':    (ds) => { setSearchPageFilter(ds.filter); renderPage('search'); },
});

registerMousedownActions({
  'gs.go':      (ds) => gsGo(ds.type, ds.ref),
  'gs.openAll': (ds) => gsOpenAllResults(ds.q),
});

registerInputActions({
  'gs.setQuery': (ds, el) => searchPageSetQuery(el.value),
});

// The top-bar search input (#gs-input) is static markup in index.html, so its
// input / focus / keydown handlers are wired once at startup (app.js calls
// this) rather than via the delegation harness — focus + keydown are sparse,
// single-element events not worth a registry, and globalSearch/gsKey are now
// module-internal (no longer on the window bridge).
export function initGlobalSearchInput() {
  const el = document.getElementById('gs-input');
  if (!el) return;
  el.addEventListener('input',   () => globalSearch(el.value));
  el.addEventListener('focus',   () => globalSearch(el.value));
  el.addEventListener('keydown', (e) => gsKey(e));
}
