import { THEME, applyTheme, setTheme } from './core/theme.js';
import { AI_API_KEY, AI_MODEL, setAIKey, setAIModel, callClaude } from './ai/client.js';
import { summarizeTicket, clearTicketSummary } from './ai/summarize.js';
import {
  AGENT_PREFERRED_LANG, TRANSLATOR_LANGS,
  translateText, translateMessage, hideMessageTranslation,
  detectLanguage, detectAndTranslateThread,
  toggleThreadTranslate, toggleAutoTranslateReplies,
  setCustomerLanguage, setAgentPreferredLang,
  showTranslatorModal, runTranslator, copyTxResult,
} from './ai/translate.js';
import { aiAction } from './ai/reply.js';
import {
  ticketTotalMinutes, ticketBillableMinutes,
  addTimeEntry, removeTimeEntry, showLogTimeModal,
} from './tickets/time-tracking.js';
import {
  snoozeTicket, unsnoozeTicket, checkSnoozeWakeups,
  formatSnoozeUntil, snoozePresetIso,
  showSnoozeModal, bulkSnoozeTickets,
} from './tickets/snooze.js';
import {
  SLA_WARN_FRACTION, BUSINESS_HOURS,
  slaNowForDemo, invalidateSLAClock,
  findMatchingSLAPolicy, ticketFirstResponseMinutes, ticketElapsedMinutes,
  bhParseHM, isWithinBusinessHours, bhInvalidateCache, businessMinutesBetween,
  computeTicketSLA, refreshTicketSLA, refreshAllSLA,
} from './tickets/sla.js';
import {
  linkTickets, unlinkTicket,
  mergeTickets, unmergeTicket,
  showLinkTicketModal, showMergeTicketModal,
} from './tickets/linked.js';
import {
  parseMentions, renderTextWithMentions,
  updateMentionDropdown, hideMentionDropdown,
  insertMention, mentionDropdownKey,
} from './tickets/mentions.js';
import { loadDraft, saveDraft, clearDraft } from './tickets/drafts.js';
import {
  logTicketEvent, getTicketEvents,
  getAllActivity, ACT_KIND_META,
  actSetQuery, actGotoEntity, renderActivityLog,
} from './core/activity-log.js';
import {
  MACROS,
  runMacro, bulkRunMacro, showApplyMacroModal,
  macAddStep, macRemoveStep, macStepKindChange,
  macNew, macEdit, macDelete, renderMacros,
} from './tickets/macros.js';
import { addMockAttachment, removeAttachment, showAttachPanel } from './tickets/attachments.js';
import {
  newAIConv, selectAIConv, deleteAIConv,
  copyAIMessage, useFollowUp, renderAI, initAI,
  aiToggleSource, aiUsePrompt, aiClear, aiInputKey, aiSend,
} from './ai/page.js';
import {
  portalSetCustomer, portalExit, portalNav, portalOpenTicket,
  portalSendReply, portalCreateTicket, renderPortal,
} from './portal/preview.js';
import {
  dismissEmail, markSpamEmail, restoreEmail,
  convertEmailToTicket, renderInbox,
} from './inbox/index.js';
import {
  renderChannels, openChannel,
  chToggle, chNew, chEdit, chDelete,
} from './channels/index.js';
import {
  fireWebhook, ticketPayload, renderWebhooks,
  whNew, whEdit, whApplyTemplate, whToggle, whDelete, whTestFire,
} from './webhooks/index.js';
import {
  renderTemplates, tplSetQuery,
  tplNew, tplEdit, tplDuplicate, tplDelete,
} from './tickets/templates.js';
import {
  ticketCSATBlock, requestCSAT, openCSATSurveyModal,
  csatHover, csatPick, submitCSAT, renderCSAT,
} from './tickets/csat.js';

// ─── State ───────────────────────────────────────────────────────────────────
let FILTER_STATUS = 'all';
let FILTER_VIEW = 'all';
let TICKET_GROUP_BY = 'none';
let TICKET_HEADER_CB_INDETERMINATE = false;
let SORT_COL = 'id';
let SORT_DIR = 1;
let REPORT_TF = '30d';
let CUST_TAB = 'all';

function login(role, name, initials) {
  SESSION = {role, name, initials};
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('sb-av').textContent = initials;
  document.getElementById('sb-uname').textContent = name;
  document.getElementById('sb-urole').textContent = role;
  document.getElementById('sf-name').textContent = name;
  document.getElementById('pf-av-sm').textContent = initials;
  document.getElementById('pf-av-lg').textContent = initials;
  document.getElementById('pf-name-sm').textContent = name;
  document.getElementById('pf-name-lg').textContent = name;
  document.getElementById('pf-role-lg').textContent = role;
  if (role === 'Read Only') document.getElementById('nav-roles').style.opacity = '.3';
  applyTheme(THEME);
  refreshAllSLA();
  checkSnoozeWakeups();
  if (!window._snoozeTimer) {
    // Poll every 30s for snoozes that have elapsed; in a real app this would
    // be server-driven but for the demo a tick is sufficient.
    window._snoozeTimer = setInterval(() => {
      const woke = checkSnoozeWakeups();
      if (woke) refreshNotifBadge();
    }, 30 * 1000);
  }
  renderPage('dashboard');
}
function logout() {
  SESSION = null;
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function nav(page, el) {
  document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');
  renderPage(page);
}
function renderPage(page) {
  if (page !== 'roles')     ROLES_VIEW_AGENTS = null;
  if (page !== 'kb')        KB_SELECTED = null;
  if (page !== 'agents')    AGENT_SELECTED = null;
  if (page !== 'customers') { CUSTOMER_SELECTED = null; CUSTOMER_SELECTED_IDS.clear(); }
  if (page !== 'tickets')   TICKET_SELECTED_IDS.clear();
  if (page !== 'inbox')     INBOX_SELECTED_ID = null;
  if (page !== 'workflows') WF_SELECTED = null;
  if (page !== 'tags')      { TAG_SELECTED = null; TAG_SELECTED_NAMES.clear(); }
  CURRENT_PAGE = page;
  CURRENT_TICKET = null;
  const main = document.getElementById('main-area');
  const pages = {
    dashboard: renderDashboard,
    tickets:   renderTickets,
    inbox:     renderInbox,
    customers: renderCustomers,
    reports:   renderReports,
    agents:    renderAgents,
    ai:        renderAI,
    kb:        renderKB,
    workflows: renderWorkflows,
    tags:      renderTags,
    roles:     renderRoles,
    sla:           renderSLA,
    'business-hours': renderBusinessHours,
    'assignment-rules': renderAssignmentRules,
    csat:          renderCSAT,
    templates:     renderTemplates,
    macros:        renderMacros,
    'ticket-templates': renderTicketTemplates,
    'custom-fields': renderCustomFields,
    layouts:       renderLayouts,
    activity:      renderActivityLog,
    portal:        renderPortal,
    search:        renderSearchResults,
    channels:      renderChannels,
    webhooks:      renderWebhooks,
    settings:      renderSettings,
    help:          renderHelp,
    notifications: renderNotificationsPage,
    profile:       renderProfile,
  };
  if (pages[page]) main.innerHTML = pages[page]();
  if (page === 'ai') initAI();
  if (page === 'reports') drawReportCharts();
  if (page === 'tickets') initTicketsPage();
  applyCollapsibleHeaders();
  updateNavBadges();
}

// ─── Collapsible sections ───────────────────────────────────────────────────
// After each renderPage we inject a small caret into every .kpi-bar /
// .filter-bar / .tab-bar so an agent can hide chrome they don't need today.
// Section IDs are page-scoped + indexed within the page, so a page with
// multiple filter bars (e.g. tickets has two) tracks them independently.
let COLLAPSED_SECTIONS = new Set(JSON.parse(localStorage.getItem('collapsed_sections') || '[]'));
const SEC_LABELS = {
  'kpi-bar':    'KPIs',
  'filter-bar': 'Filters',
  'tab-bar':    'Tabs',
};

function persistCollapsedSections() {
  localStorage.setItem('collapsed_sections', JSON.stringify([...COLLAPSED_SECTIONS]));
}

// Single source of truth for class + caret + aria sync. Both the post-render
// initial pass and the click handler call this so the visible state can't
// drift out of sync with COLLAPSED_SECTIONS.
function syncCollapsedSectionDom(el, id) {
  if (!el) return;
  const collapsed = COLLAPSED_SECTIONS.has(id);
  el.classList.toggle('sec-collapsed', collapsed);
  const caret = el.querySelector(':scope > .sec-caret');
  if (caret) {
    // When expanded, the caret carries a clear "Hide" label so it's
    // discoverable. When collapsed the whole bar is the affordance, so
    // the caret reduces to a small chevron next to the "▸ Show …" label.
    caret.innerHTML = collapsed ? '▸' : '▾&nbsp;Hide';
    caret.title = collapsed ? 'Show section' : 'Hide section';
    caret.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }
}

function toggleSection(id, event) {
  if (event) event.stopPropagation();
  if (COLLAPSED_SECTIONS.has(id)) COLLAPSED_SECTIONS.delete(id);
  else COLLAPSED_SECTIONS.add(id);
  persistCollapsedSections();
  // Mutate the live element so input focus / scroll / bulk-selection survive.
  syncCollapsedSectionDom(document.querySelector(`[data-sec-id="${CSS.escape(id)}"]`), id);
  // Settings → Appearance shows a counter of hidden sections; re-render so
  // the count and the "Show all" button's disabled state stay current.
  if (CURRENT_PAGE === 'settings' && SETTINGS_TAB === 'appearance') renderPage('settings');
}

function applyCollapsibleHeaders() {
  const sels = ['.kpi-bar', '.filter-bar', '.tab-bar'];
  const page = CURRENT_PAGE || 'page';
  sels.forEach(sel => {
    document.querySelectorAll(sel).forEach((el, i) => {
      // Stable id per page + kind + index. A page with multiple filter bars
      // (tickets has two) tracks each independently.
      const kind = sel.slice(1);
      const id = `${page}:${kind}:${i}`;
      el.dataset.secId = id;
      el.dataset.collapsedLabel = '▸ Show ' + (SEC_LABELS[kind] || 'section');
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      if (!el.querySelector(':scope > .sec-caret')) {
        const btn = document.createElement('button');
        btn.className = 'sec-caret';
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Toggle section');
        btn.addEventListener('click', e => toggleSection(id, e));
        el.appendChild(btn);
        // Whole-bar click expands when collapsed. Element is fresh on every
        // page render (innerHTML replacement) so we can bind without a
        // double-bind guard.
        el.addEventListener('click', e => {
          if (!el.classList.contains('sec-collapsed')) return;
          if (e.target.closest('.sec-caret')) return;
          toggleSection(id, e);
        });
      }
      syncCollapsedSectionDom(el, id);
    });
  });
}

function resetAllCollapsedSections() {
  COLLAPSED_SECTIONS.clear();
  persistCollapsedSections();
  renderPage(CURRENT_PAGE || 'dashboard');
}

function initTicketsPage() {
  const cb = document.getElementById('ticket-select-all-cb');
  if (cb) cb.indeterminate = TICKET_HEADER_CB_INDETERMINATE;
}

function updateNavBadges() {
  document.getElementById('nb-open').textContent = TICKETS.filter(t => t.status === 'open' || t.status === 'escalated').length;
  const inboxBadge = document.getElementById('nb-inbox');
  if (inboxBadge) {
    const newCount = INBOX.filter(e => e.status === 'new').length;
    inboxBadge.textContent = newCount;
    inboxBadge.style.display = newCount > 0 ? '' : 'none';
  }
  refreshNotifBadge();
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
// ─── Tickets ──────────────────────────────────────────────────────────────────
function renderTickets() {
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
    return `<tr onclick="openTicket('${t.id}')" style="cursor:pointer${checked?';background:var(--purple-lt)':''}">
      <td style="width:32px;padding-right:0" onclick="event.stopPropagation()">
        <input type="checkbox" ${checked?'checked':''} onchange="toggleTicketSelected('${t.id}')" style="cursor:pointer;accent-color:var(--purple)" />
      </td>
      <td class="bold">${t.id}</td>
      <td>${cust ? cust.first+' '+cust.last : '—'}</td>
      <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--ink)">${t.subject}${t.snoozedUntil && new Date(t.snoozedUntil).getTime() > Date.now() ? ` <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);font-weight:400" title="Snoozed">💤 ${escHtml(formatSnoozeUntil(t.snoozedUntil))}</span>` : ''}</td>
      <td><span class="tag tag-${t.status}">${t.status}</span></td>
      <td><span class="tag tag-${t.priority}">${t.priority}</span></td>
      <td>${t.category}</td>
      <td>${t.agent || '<span style="color:var(--ink3)">Unassigned</span>'}</td>
      <td style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${t.updated}</td>
      <td><span class="sla-${t.sla}" style="font-family:'Inter',sans-serif;font-size:11px;font-weight:500;text-transform:uppercase">${t.sla}</span></td>
    </tr>`;
  };

  const groupHeader = key => `<tr style="background:var(--off2)"><td colspan="10" style="padding:8px 14px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink3);text-transform:capitalize">${key}</td></tr>`;
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
        ${MACROS.map(m => `<option value="${escAttr(m.id)}">${escHtml(m.icon || '⚡')} ${escHtml(m.name)}</option>`).join('')}
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
      </div>
    </div>`;
}

function setStatusFilter(s) { FILTER_STATUS = s; renderPage('tickets'); }
function sortTickets(col) {
  if (SORT_COL === col) SORT_DIR *= -1; else { SORT_COL = col; SORT_DIR = 1; }
  renderPage('tickets');
}
function setAgentFilter(v)  { FILTER_AGENT = v; renderPage('tickets'); }
function setTicketView(v)   { FILTER_VIEW = v;  renderPage('tickets'); }
function setTicketQuery(q)  {
  FILTER_QUERY = q;
  renderPage('tickets');
  const input = document.getElementById('ticket-search');
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}
function setTicketGroupBy(v) { TICKET_GROUP_BY = v; renderPage('tickets'); }

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

function bulkAssignTickets() {
  if (TICKET_SELECTED_IDS.size === 0) return;
  showModal(`Assign ${TICKET_SELECTED_IDS.size} ticket${TICKET_SELECTED_IDS.size===1?'':'s'}`, `
    <div class="form-row"><label class="form-label">Assign to</label>
      <select class="form-input" id="bulk-agent">${AGENTS.map(a => `<option value="${escAttr(a.name)}">${escHtml(a.name)}${isAgentOOO(a.name) ? ' (OOO)' : ''}</option>`).join('')}</select>
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
    closeModal(); renderPage('tickets');
  }, 'Assign');
}

function bulkSetStatus(v) {
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
  updateNavBadges();
  renderPage('tickets');
}

function bulkSetPriority(v) {
  if (!v || TICKET_SELECTED_IDS.size === 0) return;
  TICKETS.forEach(t => {
    if (!TICKET_SELECTED_IDS.has(t.id)) return;
    if (t.priority === v) return;
    logTicketEvent(t.id, 'priority', `Priority: ${t.priority} → ${v} (bulk)`);
    t.priority = v;
    refreshTicketSLA(t);
  });
  TICKET_SELECTED_IDS.clear();
  renderPage('tickets');
}

function bulkAddTag() {
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
    renderPage('tickets');
  }, 'Apply tag');
}

function bulkExportTickets() {
  if (TICKET_SELECTED_IDS.size === 0) return;
  const list = TICKETS.filter(t => TICKET_SELECTED_IDS.has(t.id));
  const headers = ['ID','Customer','Subject','Status','Priority','Category','Agent','Created','Updated','SLA','Tags','CSAT','Time logged','Time billable'];
  const rows = list.map(t => {
    const cust = CUSTOMERS.find(c => c.id === t.customerId);
    return [t.id, cust ? cust.first + ' ' + cust.last : '', t.subject, t.status, t.priority, t.category, t.agent || '', t.created, t.updated, t.sla, (t.tags || []).join(';'), t.csat ?? '', fmtMinutes(ticketTotalMinutes(t)), fmtMinutes(ticketBillableMinutes(t))];
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

function bulkDeleteTickets() {
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
    updateNavBadges();
    renderPage('tickets');
  }, 'Delete');
}

function exportTicketList() {
  const list = getFilteredTickets();
  const headers = ['ID','Customer','Subject','Status','Priority','Category','Agent','Created','Updated','SLA','Tags','CSAT','Time logged','Time billable'];
  const rows = list.map(t => {
    const cust = CUSTOMERS.find(c => c.id === t.customerId);
    return [t.id, cust ? cust.first + ' ' + cust.last : '', t.subject, t.status, t.priority, t.category, t.agent || '', t.created, t.updated, t.sla, (t.tags || []).join(';'), t.csat ?? '', fmtMinutes(ticketTotalMinutes(t)), fmtMinutes(ticketBillableMinutes(t))];
  });
  const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `tickets-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ─── Ticket Detail ────────────────────────────────────────────────────────────
function openTicket(id) {
  CURRENT_TICKET = id;
  const t = TICKETS.find(x => x.id === id);
  const cust = CUSTOMERS.find(c => c.id === t.customerId);
  const otherTickets = TICKETS.filter(x => x.customerId === t.customerId && x.id !== id && !x.mergedInto);
  const snoozeBanner = (t.snoozedUntil && new Date(t.snoozedUntil).getTime() > Date.now()) ? `
    <div style="margin:0 0 10px;padding:8px 12px;background:var(--off2);border:1px solid var(--rule2);border-radius:var(--r);font-size:11px;color:var(--ink2);display:flex;align-items:center;gap:8px">
      <span style="font-size:14px">💤</span>
      <span style="font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--ink3)">Snoozed</span>
      <span style="color:var(--ink2)">${escHtml(formatSnoozeUntil(t.snoozedUntil))}</span>
      ${t.snoozeReason ? `<span style="color:var(--ink3);font-style:italic">· ${escHtml(t.snoozeReason)}</span>` : ''}
      <button class="btn btn-sm" style="margin-left:auto" onclick="unsnoozeTicket('${escAttr(t.id)}')">Wake up</button>
    </div>` : '';
  const mergedFromIds = (t.mergedFrom || []);
  const mergedBanner = t.mergedInto ? `
    <div style="margin:0 0 10px;padding:8px 12px;background:var(--purple-lt);border:1px solid var(--purple);border-radius:var(--r);font-size:11px;color:var(--purple);display:flex;align-items:center;gap:8px">
      <span style="font-weight:600;text-transform:uppercase;letter-spacing:.06em">Merged duplicate</span>
      <span style="color:var(--ink2)">→</span>
      <span class="link" onclick="openTicket('${escAttr(t.mergedInto)}')" style="color:var(--purple);font-weight:500">${escHtml(t.mergedInto)}</span>
      <span style="color:var(--ink3);font-family:'DM Mono',monospace;font-size:10px">on ${escHtml(t.mergedAt || '—')}</span>
      <button class="btn btn-sm" style="margin-left:auto" onclick="unmergeTicket('${escAttr(t.id)}')">Un-merge</button>
    </div>` : '';
  const mergedFromBlock = mergedFromIds.length ? `
    <div class="ts-section">
      <div class="ts-heading">Merged duplicates (${mergedFromIds.length})</div>
      ${mergedFromIds.map(mid => {
        const m = TICKETS.find(x => x.id === mid);
        if (!m) return '';
        return `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid var(--rule)">
            <div style="flex:1;min-width:0;cursor:pointer" onclick="openTicket('${escAttr(mid)}')">
              <div style="font-size:11.5px;color:var(--ink2);line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(m.subject)}</div>
              <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
                <span class="tag" style="font-size:9px;background:var(--purple-lt);color:var(--purple);border:1px solid var(--purple)">merged</span>
                <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${escHtml(mid)} · ${escHtml(m.mergedAt || '—')}</span>
              </div>
            </div>
          </div>`;
      }).join('')}
    </div>` : '';
  const csatScore = cust ? TICKETS.filter(x=>x.customerId===cust.id&&x.csat).reduce((a,x)=>a+x.csat,0) / (TICKETS.filter(x=>x.customerId===cust.id&&x.csat).length||1) : 0;
  const csatColor = csatScore >= 4 ? '#007744' : csatScore >= 3 ? '#0044cc' : '#cc2200';
  const csatPct = Math.round((csatScore/5)*100);
  const circumference = 2*Math.PI*18;
  const dash = (csatPct/100)*circumference;

  const pendingAITags = t.aiTags.filter(x => !x.accepted);
  const aiTagsHtml = pendingAITags.length ? `
    <div class="ts-section">
      <div class="ts-heading">AI Tag Suggestions</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">
        ${pendingAITags.map(at=>`<span class="ai-tag-chip" onclick="acceptAITag('${id}','${at.tag}')">${at.tag} <span class="conf">${at.conf}%</span></span>`).join('')}
      </div>
      <button class="btn btn-sm" onclick="acceptAllAITags('${id}')">Accept all</button>
    </div>` : '';

  const times = getTicketTimes(t);
  const timeBlock = `
    <div class="ts-section">
      <div class="ts-heading">Timing</div>
      <div class="ts-row"><span class="ts-key">Created</span><span class="ts-val">${times.created}</span></div>
      <div class="ts-row"><span class="ts-key">Age</span><span class="ts-val">${times.age}</span></div>
      <div class="ts-row"><span class="ts-key">First response</span><span class="ts-val">${times.firstResp}</span></div>
      <div class="ts-row"><span class="ts-key">Last update</span><span class="ts-val">${times.lastUpdate}</span></div>
      ${t.attachments && t.attachments.length ? `<div class="ts-row"><span class="ts-key">Attachments</span><span class="ts-val"><span class="link" onclick="showAttachPanel('${id}')">${t.attachments.length}</span></span></div>` : ''}
    </div>`;

  // SLA evaluation block — computed live from policies + ticket timing.
  const sla = computeTicketSLA(t);
  const slaColor = s => s === 'breach' ? 'var(--red)' : s === 'warn' ? 'var(--amber)' : s === 'snoozed' ? 'var(--ink3)' : 'var(--green)';
  const slaBar = (used, total, status) => {
    const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
    return `<div style="height:5px;background:var(--off2);border-radius:3px;overflow:hidden;margin-top:4px"><div style="height:100%;background:${slaColor(status)};width:${pct}%;transition:width .25s"></div></div>`;
  };
  const bhActive = BUSINESS_HOURS.enabled;
  const bhPaused = bhActive && !isWithinBusinessHours(new Date());
  const slaBlock = `
    <div class="ts-section">
      <div class="ts-heading">SLA${bhPaused ? ' <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--ink3);font-size:10px;font-style:italic;margin-left:4px">· paused (outside hours)</span>' : ''}</div>
      ${sla.policy ? `
        <div class="ts-row"><span class="ts-key">Policy</span><span class="ts-val"><span class="link" onclick="navTo('sla')">${escHtml(sla.policy.name)}</span></span></div>
        ${bhActive ? `<div class="ts-row"><span class="ts-key">Hours</span><span class="ts-val"><span class="link" onclick="navTo('business-hours')">Business hours</span></span></div>` : ''}
        <div style="margin-top:10px">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink2)">
            <span>First response</span>
            <span style="color:${slaColor(sla.firstResponseStatus)};font-weight:500;text-transform:uppercase;font-size:10px;letter-spacing:.06em">${escHtml(sla.firstResponseStatus)}</span>
          </div>
          <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);margin-top:2px">${fmtSLAMinutes(sla.firstRespMin != null ? sla.firstRespMin : sla.elapsedMin)} ${sla.firstRespMin != null ? 'taken' : 'so far'} · target ${fmtSLAMinutes(sla.policy.firstResponseMin)}</div>
          ${slaBar(sla.firstRespMin != null ? sla.firstRespMin : sla.elapsedMin, sla.policy.firstResponseMin, sla.firstResponseStatus)}
        </div>
        <div style="margin-top:10px">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink2)">
            <span>Resolution</span>
            <span style="color:${slaColor(sla.resolutionStatus)};font-weight:500;text-transform:uppercase;font-size:10px;letter-spacing:.06em">${sla.isResolved ? 'resolved' : escHtml(sla.resolutionStatus)}</span>
          </div>
          <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);margin-top:2px">${fmtSLAMinutes(sla.elapsedMin)} elapsed · target ${fmtSLAMinutes(sla.policy.resolutionMin)}</div>
          ${slaBar(sla.elapsedMin, sla.policy.resolutionMin, sla.isResolved ? 'ok' : sla.resolutionStatus)}
        </div>
      ` : `<div style="font-size:11px;color:var(--ink3);font-style:italic">No active policy matches this ticket. Configure one in <span class="link" onclick="navTo('sla')">SLA Policies</span>.</div>`}
    </div>`;

  const summarizing = t.aiSummary && t.aiSummary.summarizing;
  const summary = t.aiSummary && !t.aiSummary.summarizing ? t.aiSummary : null;
  const summaryStale = summary && summary.coveredMsgCount !== undefined && summary.coveredMsgCount !== null && (t.msgs || []).length > summary.coveredMsgCount;
  const aiSummaryBlock = summarizing ? `
    <div class="ts-section">
      <div class="ts-heading">AI Summary <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--purple);font-size:10px;font-style:italic;margin-left:4px">generating…</span></div>
      <div style="font-size:11px;color:var(--ink3);font-style:italic">Talking to Claude…</div>
    </div>` : (summary ? `
    <div class="ts-section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div class="ts-heading" style="margin:0">AI Summary${summaryStale ? '<span class="ts-stale-badge">stale</span>' : ''}</div>
        <span style="display:flex;gap:10px">
          <span class="link" onclick="summarizeTicket('${escAttr(id)}')" style="font-size:11px">Refresh</span>
          <span class="link" onclick="clearTicketSummary('${escAttr(id)}')" style="font-size:11px;color:var(--ink3)">×</span>
        </span>
      </div>
      ${summary.error ? `<div style="font-size:11px;color:var(--red);font-style:italic">${escHtml(summary.error)}</div>` : `
        <div style="font-size:12px;color:var(--ink);line-height:1.5;margin-bottom:8px">${escHtml(summary.tldr || '')}</div>
        ${summary.issue ? `<div style="font-size:11px;color:var(--ink2);line-height:1.5;margin-bottom:4px"><strong style="color:var(--purple);text-transform:uppercase;font-size:10px;letter-spacing:.06em">Issue · </strong>${escHtml(summary.issue)}</div>` : ''}
        ${summary.done ? `<div style="font-size:11px;color:var(--ink2);line-height:1.5;margin-bottom:4px"><strong style="color:var(--green);text-transform:uppercase;font-size:10px;letter-spacing:.06em">Done · </strong>${escHtml(summary.done)}</div>` : ''}
        ${summary.next ? `<div style="font-size:11px;color:var(--ink2);line-height:1.5;margin-bottom:4px"><strong style="color:var(--amber);text-transform:uppercase;font-size:10px;letter-spacing:.06em">Next · </strong>${escHtml(summary.next)}</div>` : ''}
        <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);margin-top:6px">covered ${summary.coveredMsgCount || 0} msg${summary.coveredMsgCount === 1 ? '' : 's'} · ${escHtml((summary.generatedAt || '').slice(0, 16).replace('T', ' '))}</div>
      `}
    </div>` : '');

  const followers = t.followers || [];
  const watching = SESSION ? followers.includes(SESSION.name) : false;
  const followerAvatars = followers.map(name => {
    const ag = AGENTS.find(a => a.name === name);
    const initials = ag ? ag.initials : (name.split(/\s+/).map(w => w[0]).join('').slice(0,2).toUpperCase());
    return `<div title="${name}" style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:#fff;flex-shrink:0;margin-left:-6px;border:2px solid var(--off)">${initials}</div>`;
  }).join('');
  const followersBlock = `
    <div class="ts-section">
      <div class="ts-heading">Followers (${followers.length})</div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div style="display:flex;padding-left:6px">${followerAvatars || '<span style="font-size:11px;color:var(--ink3)">No followers yet</span>'}</div>
        <button class="btn btn-sm" onclick="toggleWatch('${id}')">${watching ? 'Unfollow' : 'Follow'}</button>
      </div>
    </div>`;

  const kbSuggestions = getSuggestedKB(t);
  const kbBlock = kbSuggestions.length ? `
    <div class="ts-section">
      <div class="ts-heading">Suggested KB</div>
      ${kbSuggestions.map(a => `
        <div onclick="KB_SELECTED='${escAttr(a.id)}';navTo('kb')" style="padding:8px 10px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;margin-bottom:5px;background:var(--off2);transition:all .15s" onmouseover="this.style.borderColor='var(--purple)'" onmouseout="this.style.borderColor='var(--rule)'">
          <div style="font-size:10px;color:var(--purple);text-transform:uppercase;letter-spacing:.04em;font-weight:600;margin-bottom:2px">${a.category}</div>
          <div style="font-size:12px;color:var(--ink);font-weight:500;line-height:1.3">${a.title}</div>
        </div>`).join('')}
    </div>` : '';

  // External-KB suggestions are fetched lazily and cached by ticket id. The
  // sidebar shows a loading shimmer first paint, then the results on the
  // re-render. If the integration is disabled the whole block stays hidden.
  let extKbBlock = '';
  if (KB_INTEGRATION.enabled) {
    const cache = KB_TICKET_CACHE.get(t.id);
    if (cache === undefined) setTimeout(() => refreshTicketKbSuggestions(t.id), 0);
    const head = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div class="ts-heading" style="margin:0">External KB</div>
        <span class="link" onclick="refreshTicketKbSuggestions('${escAttr(t.id)}')" style="font-size:11px">Refresh</span>
      </div>`;
    let body = '';
    if (!cache || cache.loading) body = '<div style="font-size:11px;color:var(--ink3);font-style:italic">Searching your KB…</div>';
    else if (cache.error)        body = `<div style="font-size:11px;color:var(--red);font-style:italic">${escHtml(cache.error)}</div>`;
    else if (!cache.articles.length) body = '<div style="font-size:11px;color:var(--ink3);font-style:italic">No matching articles.</div>';
    else body = cache.articles.map(a => {
      // External URL goes into an href, so escape with escHtml (handles ", &,
      // <, >). Also restrict to http(s) so a malicious KB can't ship a
      // javascript: link that runs on click.
      const safeUrl = (typeof a.url === 'string' && /^https?:\/\//i.test(a.url.trim())) ? a.url.trim() : '';
      return `
      <div style="padding:8px 10px;border:1px solid var(--rule);border-radius:var(--r);margin-bottom:5px;background:var(--off2)">
        ${safeUrl ? `<a href="${escHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" style="font-size:12px;color:var(--ink);font-weight:500;text-decoration:none;line-height:1.3">${escHtml(a.title)} ↗</a>` : `<div style="font-size:12px;color:var(--ink);font-weight:500;line-height:1.3">${escHtml(a.title)}</div>`}
        ${a.body ? `<div style="font-size:11px;color:var(--ink3);margin-top:4px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${escHtml(String(a.body).slice(0, 200))}</div>` : ''}
      </div>`;
    }).join('');
    extKbBlock = `<div class="ts-section">${head}${body}</div>`;
  }

  const totalTimeMin    = ticketTotalMinutes(t);
  const billableTimeMin = ticketBillableMinutes(t);
  const recentTime      = (t.timeEntries || []).slice(0, 4);
  const timeLogBlock = `
    <div class="ts-section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div class="ts-heading" style="margin:0">Time logged${totalTimeMin ? ` · ${fmtMinutes(totalTimeMin)}` : ''}</div>
        <span class="link" onclick="showLogTimeModal('${id}')" style="font-size:11px">+ Log time</span>
      </div>
      ${totalTimeMin ? `
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink2);margin-bottom:8px">
          <span>Total <strong style="color:var(--ink)">${fmtMinutes(totalTimeMin)}</strong></span>
          <span>Billable <strong style="color:${billableTimeMin === totalTimeMin ? 'var(--ink)' : 'var(--amber)'}">${fmtMinutes(billableTimeMin)}</strong></span>
        </div>
        ${recentTime.map(e => `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid var(--rule)">
            <div style="flex:1;min-width:0">
              <div style="font-size:11.5px;color:var(--ink);font-weight:500">${fmtMinutes(e.minutes)}${e.billable === false ? ' <span style="color:var(--ink3);font-weight:400;font-size:10px">· non-billable</span>' : ''}</div>
              ${e.note ? `<div style="font-size:11px;color:var(--ink2);font-style:italic;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">"${escHtml(e.note)}"</div>` : ''}
              <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);margin-top:2px">${escHtml(e.agent)} · ${escHtml(e.ts)}</div>
            </div>
            <button onclick="removeTimeEntry(${escHtml(JSON.stringify(id))},${escHtml(JSON.stringify(e.id))})" style="background:transparent;border:none;color:var(--ink3);cursor:pointer;font-size:14px;padding:4px 6px;line-height:1" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--ink3)'" title="Remove entry">×</button>
          </div>`).join('')}
      ` : `<div style="font-size:11px;color:var(--ink3);text-align:center;padding:8px 0">No time logged yet</div>`}
    </div>`;

  const linkedIds = t.linked || [];
  const linkedBlock = `
    <div class="ts-section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div class="ts-heading" style="margin:0">Linked tickets (${linkedIds.length})</div>
        <span style="display:flex;gap:10px">
          <span class="link" onclick="showLinkTicketModal('${id}')" style="font-size:11px">+ Link</span>
          ${t.mergedInto ? '' : `<span class="link" onclick="showMergeTicketModal('${id}')" style="font-size:11px">↩ Merge</span>`}
        </span>
      </div>
      ${linkedIds.length ? linkedIds.map(linkedId => {
        const lt = TICKETS.find(x => x.id === linkedId);
        if (!lt) return '';
        return `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;padding:7px 0;border-bottom:1px solid var(--rule)">
            <div style="flex:1;min-width:0;cursor:pointer" onclick="openTicket('${linkedId}')">
              <div style="font-size:11.5px;color:var(--ink2);line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${lt.subject}</div>
              <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
                <span class="tag tag-${lt.status}" style="font-size:9px">${lt.status}</span>
                <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${linkedId}</span>
              </div>
            </div>
            <button onclick="unlinkTicket('${id}','${linkedId}')" style="background:transparent;border:none;color:var(--ink3);cursor:pointer;font-size:14px;padding:4px 6px;flex-shrink:0;line-height:1" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--ink3)'" title="Unlink">×</button>
          </div>`;
      }).join('') : '<div style="font-size:11px;color:var(--ink3);text-align:center;padding:8px 0">No linked tickets</div>'}
    </div>`;

  const eventColors = { status:'var(--cyan)', priority:'var(--amber)', agent:'var(--purple)', tag:'var(--green)', system:'var(--ink3)' };
  const events = getTicketEvents(t);
  const activityBlock = events.length ? `
    <div class="ts-section">
      <div class="ts-heading">Activity (${events.length})</div>
      <div style="max-height:240px;overflow-y:auto;margin-right:-4px;padding-right:4px">
        ${events.slice(0, 12).map(e => `
          <div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--rule)">
            <div style="width:6px;height:6px;border-radius:50%;background:${eventColors[e.type] || 'var(--ink4)'};margin-top:5px;flex-shrink:0"></div>
            <div style="flex:1;min-width:0">
              <div style="font-size:11px;color:var(--ink2);line-height:1.4;word-break:break-word">${e.details}</div>
              <div style="font-size:10px;color:var(--ink3);font-family:'DM Mono',monospace;margin-top:2px">${e.author === 'System' ? '' : e.author + ' · '}${e.ts}</div>
            </div>
          </div>`).join('')}
      </div>
    </div>` : '';

  const threadOn = !!t.translateThread;
  const msgsHtml = t.msgs.map((m, i) => {
    let translateBlock = '';
    let bodyText = m.t;
    let bodyNote = '';

    if (m.r === 'customer') {
      // Thread translation: show translation as the primary body when available
      if (threadOn && m.translatedFor === AGENT_PREFERRED_LANG && m.translation) {
        bodyText = m.translation;
        bodyNote = `<div style="margin-top:6px;font-size:10px;color:var(--ink3);font-style:italic">Translated from ${escHtml(t.detectedCustomerLang || 'auto')} → ${escHtml(AGENT_PREFERRED_LANG)} · <span class="link" onclick="hideMessageTranslation('${id}',${i})">show original</span></div>`;
      } else if (m.translating) {
        translateBlock = '<div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--rule);font-size:11px;color:var(--purple);font-style:italic">Translating…</div>';
      } else if (m.translation) {
        translateBlock = `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--rule)">
          <div style="font-size:10px;color:var(--ink3);text-transform:uppercase;letter-spacing:.06em;font-weight:500;margin-bottom:4px">Translation</div>
          <div style="font-size:13px;color:var(--ink2);font-style:italic;line-height:1.55">${escHtml(m.translation)}</div>
          <div style="margin-top:6px"><span class="link" style="font-size:11px" onclick="hideMessageTranslation('${id}',${i})">Hide translation</span></div>
        </div>`;
      } else {
        translateBlock = `<div style="margin-top:6px"><span class="link" style="font-size:11px" onclick="translateMessage('${id}',${i})">Translate</span></div>`;
      }
    } else if ((m.r === 'agent' || m.r === 'note') && m.tOriginal) {
      // Agent reply that was auto-translated for the customer — show what the agent typed
      bodyText = m.tOriginal;
      bodyNote = `<div style="margin-top:6px;font-size:10px;color:var(--ink3);font-style:italic">→ Sent to customer in ${escHtml(m.translatedTo || 'their language')} · <span class="link" onclick="showSentTextModal('${escAttr(id)}',${i})">view sent text</span></div>`;
    }

    const bodyHtml = m.r === 'note'
      ? renderTextWithMentions(bodyText)
      : escHtml(bodyText).replace(/\n/g, '<br>');
    return `
    <div class="msg msg-${m.r}">
      <div class="msg-from">${escHtml(m.from)} ${m.r==='ai'?'<span class="ai-mark">AI</span>':''} ${m.r==='note'?'<span class="note-mark">Note</span>':''}<span style="margin-left:auto;font-family:'Inter',sans-serif;font-size:11px;color:var(--ink3)">${escHtml(m.ts)}</span></div>
      ${bodyHtml}
      ${bodyNote}
      ${translateBlock}
    </div>`;
  }).join('');

  // Thread translation toolbar — sits above the message thread
  const customerLangLabel = t.detectedCustomerLang
    ? `<span style="color:var(--ink2)">Customer language: <strong style="color:var(--ink)">${escHtml(t.detectedCustomerLang)}</strong></span>`
    : `<span style="color:var(--ink3);font-style:italic">Customer language: not yet detected</span>`;
  const langOptions = TRANSLATOR_LANGS.map(l => `<option value="${l}" ${t.detectedCustomerLang===l?'selected':''}>${l}</option>`).join('');
  const threadBarHtml = `
    <div style="padding:8px 14px;border-bottom:1px solid var(--rule);background:var(--off2);display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:12px">
      <label class="auth-check" style="margin:0">
        <input type="checkbox" ${threadOn?'checked':''} onchange="toggleThreadTranslate('${id}',this.checked)">
        <span>Translate thread to <strong style="color:var(--ink)">${escHtml(AGENT_PREFERRED_LANG)}</strong></span>
      </label>
      <span style="color:var(--rule2)">·</span>
      ${customerLangLabel}
      ${(threadOn || t.autoTranslateReplies) ? `<select class="filter-select" onchange="setCustomerLanguage('${id}',this.value)" style="font-size:11px;padding:3px 8px"><option value="">— override —</option>${langOptions}</select>` : ''}
      <span style="color:var(--rule2)">·</span>
      <label class="auth-check" style="margin:0">
        <input type="checkbox" ${t.autoTranslateReplies?'checked':''} onchange="toggleAutoTranslateReplies('${id}',this.checked)">
        <span>Send replies in customer language</span>
      </label>
      ${!AI_API_KEY ? '<span style="margin-left:auto;color:var(--amber);font-family:\'DM Mono\',monospace;font-size:10px">Add API key in Settings → AI</span>' : ''}
    </div>`;

  const main = document.getElementById('main-area');
  main.innerHTML = `
    <div class="page">
      <div class="topbar">
        <div class="tb-breadcrumb">
          <span onclick="renderPage('tickets')">Tickets</span>
          <span class="tb-sep">/</span>
          <span style="color:var(--ink);font-weight:500">${t.id}</span>
          <span style="margin-left:auto;display:flex;gap:6px;align-items:center">
            <button class="btn btn-sm" onclick="prevNextTicket(-1)">← Prev</button>
            <button class="btn btn-sm" onclick="prevNextTicket(1)">Next →</button>
            <span style="width:1px;background:var(--rule);align-self:stretch;margin:0 4px"></span>
            ${t.mergedInto ? '' : `<button class="btn btn-sm" onclick="summarizeTicket('${id}')" title="Generate an AI summary of this ticket"${summarizing ? ' disabled' : ''}>${summarizing ? '⏳' : '📝'} Summarize</button>`}
            ${t.mergedInto ? '' : `<button class="btn btn-sm" onclick="showApplyMacroModal('${id}')" title="Apply a macro">⚡ Macro</button>`}
            ${t.mergedInto ? '' : `<button class="btn btn-sm" onclick="runAssignmentRulesOnTicket('${id}')" title="Auto-assign by rules">⇄ Run rules</button>`}
            ${t.status !== 'escalated' && t.status !== 'resolved' ? `<button class="btn btn-sm" onclick="quickStatus('${id}','escalated')">Escalate</button>` : ''}
            ${t.status !== 'resolved' ? (t.snoozedUntil
              ? `<button class="btn btn-sm" onclick="unsnoozeTicket('${id}')" title="Wake the ticket up now">💤 Wake up</button>`
              : `<button class="btn btn-sm" onclick="showSnoozeModal('${id}')" title="Pause SLA until a chosen time">💤 Snooze</button>`) : ''}
            ${t.status !== 'resolved'
              ? `<button class="btn btn-sm btn-solid" onclick="quickStatus('${id}','resolved')">Resolve</button>`
              : `<button class="btn btn-sm" onclick="quickStatus('${id}','open')">Reopen</button>`}
          </span>
        </div>
      </div>
      <div style="padding:14px 20px 10px;border-bottom:1px solid var(--rule);flex-shrink:0">
        ${mergedBanner}
        ${snoozeBanner}
        <div style="font-family:\'Syne\',sans-serif;font-size:17px;font-weight:700;color:var(--ink);letter-spacing:-.02em;margin-bottom:7px">${t.subject}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <span class="tag tag-${t.status}">${t.status}</span>
          <span class="tag tag-${t.priority}">${t.priority}</span>
          <span class="tag tag-neutral">${t.category}</span>
          ${t.tags.map(tg=>`<span class="tag tag-neutral" style="display:inline-flex;align-items:center;gap:4px">${tg}<span style="cursor:pointer;color:var(--ink3);font-weight:400" onclick="event.stopPropagation();removeTicketTag('${id}','${escAttr(tg)}')" title="Remove tag">×</span></span>`).join('')}
          <input id="tag-add-${id}" placeholder="+ tag" style="background:transparent;border:1px dashed var(--rule2);border-radius:3px;padding:2px 8px;font-size:10px;color:var(--ink2);width:90px;outline:none;font-family:'Inter',sans-serif;letter-spacing:.03em;text-transform:uppercase" onkeydown="if(event.key==='Enter'){event.preventDefault();addTicketTag('${id}',this.value)}"/>
          <span style="font-family:'Inter',sans-serif;font-size:11px;color:var(--ink3);margin-left:auto">SLA: <span class="sla-${t.sla}">${t.sla.toUpperCase()}</span></span>
        </div>
      </div>
      <div class="ticket-layout">
        <div class="ticket-main">
          ${threadBarHtml}
          <div class="thread" id="thread-${id}">${msgsHtml}</div>
          <div class="composer">
            <div class="composer-tabs">
              <div class="ctab ${COMPOSE_TAB==='reply'?'active':''}" onclick="setComposeTab('reply','${id}')">Reply</div>
              <div class="ctab ${COMPOSE_TAB==='note'?'active':''}" onclick="setComposeTab('note','${id}')">Internal note</div>
              <div style="margin-left:auto;display:flex;gap:4px;align-items:center;padding:0 12px">
                <span style="font-size:10px;color:var(--ink3);text-transform:uppercase;letter-spacing:.06em;font-weight:500;margin-right:4px">Insert</span>
                <button class="comp-var-btn" onclick="insertVar('${id}','{name}')" title="Customer first name">{name}</button>
                <button class="comp-var-btn" onclick="insertVar('${id}','{ticket}')" title="Ticket ID">{ticket}</button>
                <button class="comp-var-btn" onclick="insertVar('${id}','{brand}')" title="Customer brand">{brand}</button>
                <button class="comp-var-btn" onclick="insertVar('${id}','{agent}')" title="Assigned agent">{agent}</button>
              </div>
            </div>
            <div class="composer-body">
              <textarea class="compose-area" id="compose-${id}" placeholder="${COMPOSE_TAB==='reply'?'Write a reply or use AI…':'Add an internal note… type @ to mention an agent'}" oninput="onComposeInput('${id}')" onkeydown="if(mentionDropdownKey(event,'${id}'))return;" onblur="setTimeout(hideMentionDropdown,150)">${escHtml(loadDraft(id))}</textarea>
              <div class="comp-meta">
                <span id="draft-status-${id}">${loadDraft(id) ? 'Draft restored' : ''}</span>
                <span id="char-count-${id}">${loadDraft(id).length} chars</span>
              </div>
              <div class="composer-foot">
                <div class="composer-actions">
                  <select class="filter-select" id="status-sel-${id}" onchange="changeTicketStatus('${id}',this.value)">
                    <option value="open" ${t.status==='open'?'selected':''}>Open</option>
                    <option value="pending" ${t.status==='pending'?'selected':''}>Pending</option>
                    <option value="escalated" ${t.status==='escalated'?'selected':''}>Escalated</option>
                    <option value="resolved" ${t.status==='resolved'?'selected':''}>Resolved</option>
                  </select>
                  <button class="btn btn-sm" onclick="showMacroPanel('${id}')">Macros</button>
                  <button class="btn btn-sm" onclick="showAttachPanel('${id}')">Attach${t.attachments&&t.attachments.length?' · '+t.attachments.length:''}</button>
                  <button class="btn btn-sm btn-danger" onclick="showGDPRModal('${id}')">GDPR</button>
                  <div class="thinking" id="thinking-${id}"><span class="dot">·</span><span class="dot">·</span><span class="dot">·</span>&nbsp;working</div>
                </div>
                <div style="display:flex;gap:6px;align-items:center">
                  ${COMPOSE_TAB==='reply' ? `
                  <div style="position:relative;display:inline-block">
                    <button class="btn btn-sm" onclick="toggleAIMenu('${id}')">AI ▾</button>
                    <div id="ai-menu-${id}" class="comp-menu">
                      <div class="comp-menu-item" onclick="aiAction('${id}','draft')">Draft reply</div>
                      ${KB_INTEGRATION.enabled ? `<div class="comp-menu-item" onclick="aiAction('${id}','kb-reply')" title="Draft a reply grounded in your external KB">Draft reply with KB</div>` : ''}
                      <div class="comp-menu-item" onclick="aiAction('${id}','improve')">Improve writing</div>
                      <div class="comp-menu-item" onclick="aiAction('${id}','shorten')">Shorten</div>
                      <div class="comp-menu-item" onclick="aiAction('${id}','lengthen')">Add detail</div>
                      <div class="comp-menu-item" onclick="aiAction('${id}','friendly')">Friendlier tone</div>
                      <div class="comp-menu-item" onclick="aiAction('${id}','formal')">More formal</div>
                      <div class="comp-menu-item" onclick="aiAction('${id}','translate')">Translate to English</div>
                    </div>
                  </div>` : ''}
                  <div style="position:relative;display:inline-flex">
                    <button class="btn btn-sm btn-solid" style="border-radius:var(--r) 0 0 var(--r);border-right:1px solid rgba(255,255,255,0.25)" onclick="sendCompose('${id}')">${COMPOSE_TAB==='reply'?'Send':'Add note'}</button>
                    <button class="btn btn-sm btn-solid" style="border-radius:0 var(--r) var(--r) 0;padding:5px 8px" onclick="toggleSendMenu('${id}')" title="More send options">▾</button>
                    <div id="send-menu-${id}" class="comp-menu">
                      <div class="comp-menu-item" onclick="sendComposeAnd('${id}','resolved')">${COMPOSE_TAB==='reply'?'Send':'Add note'} and resolve</div>
                      <div class="comp-menu-item" onclick="sendComposeAnd('${id}','pending')">${COMPOSE_TAB==='reply'?'Send':'Add note'} and set pending</div>
                      <div class="comp-menu-item" onclick="sendComposeAnd('${id}','escalated')">${COMPOSE_TAB==='reply'?'Send':'Add note'} and escalate</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="ticket-sidebar">
          ${cust?`
          <div class="ts-section" style="cursor:pointer" onclick="openCustomerModal('${cust.id}')">
            <div class="ts-heading">Customer</div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
              <div style="width:32px;height:32px;border-radius:50%;background:var(--ink);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:var(--w);flex-shrink:0">${cust.first[0]}${cust.last[0]}</div>
              <div><div style="font-size:12px;font-weight:500;color:var(--ink)">${cust.first} ${cust.last}</div><div style="font-family:'Inter',sans-serif;font-size:11px;color:var(--ink3)">${cust.id}</div></div>
            </div>
            <div class="ts-row"><span class="ts-key">Brand</span><span class="ts-val">${cust.brand}</span></div>
            <div class="ts-row"><span class="ts-key">VIP</span><span class="vip-badge vip-${cust.vip.toLowerCase()}">${cust.vip}</span></div>
            <div class="ts-row"><span class="ts-key">Jurisdiction</span><span class="ts-val">${cust.jurisdiction}</span></div>
          </div>`:``}
          <div class="ts-section">
            <div class="ts-heading">CSAT</div>
            <div class="csat-ring-wrap">
              <div class="csat-ring">
                <svg width="44" height="44" viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" fill="none" stroke="var(--rule)" stroke-width="4"/><circle cx="22" cy="22" r="18" fill="none" stroke="${csatColor}" stroke-width="4" stroke-dasharray="${dash} ${circumference-dash}" stroke-linecap="round"/></svg>
                <div class="csat-inner" style="color:${csatColor};font-size:10px">${csatScore>0?csatScore.toFixed(1):'—'}</div>
              </div>
              <div style="font-size:11px;color:var(--ink2)">Avg score<br/><span style="color:var(--ink3);font-family:'Inter',sans-serif;font-size:11px">${TICKETS.filter(x=>x.customerId===t.customerId&&x.csat).length} rated tickets</span></div>
            </div>
          </div>
          ${aiSummaryBlock}
          ${ticketCSATBlock(t)}
          ${timeBlock}
          ${slaBlock}
          ${aiTagsHtml}
          ${followersBlock}
          ${kbBlock}
          ${extKbBlock}
          ${timeLogBlock}
          <div class="ts-section">
            <div class="ts-heading">Properties</div>
            <select class="ts-select" onchange="changeTicketStatus('${id}',this.value)">
              <option value="open" ${t.status==='open'?'selected':''}>Open</option>
              <option value="pending" ${t.status==='pending'?'selected':''}>Pending</option>
              <option value="escalated" ${t.status==='escalated'?'selected':''}>Escalated</option>
              <option value="gdpr" ${t.status==='gdpr'?'selected':''}>GDPR</option>
              <option value="resolved" ${t.status==='resolved'?'selected':''}>Resolved</option>
            </select>
            <select class="ts-select" onchange="changeTicketPriority('${id}',this.value)">
              <option value="urgent" ${t.priority==='urgent'?'selected':''}>Urgent</option>
              <option value="high" ${t.priority==='high'?'selected':''}>High</option>
              <option value="normal" ${t.priority==='normal'?'selected':''}>Normal</option>
              <option value="low" ${t.priority==='low'?'selected':''}>Low</option>
            </select>
            <select class="ts-select" onchange="changeTicketAgent('${id}',this.value)">
              ${AGENTS.map(a=>`<option value="${escAttr(a.name)}" ${t.agent===a.name?'selected':''}>${escHtml(a.name)}${isAgentOOO(a.name) ? ' (OOO)' : ''}</option>`).join('')}
            </select>
          </div>
          ${t.status==='gdpr'||t.category==='GDPR'?`
          <div class="ts-section">
            <div class="ts-heading">GDPR Actions</div>
            <button class="btn btn-sm btn-danger" style="width:100%;margin-bottom:5px;justify-content:center" onclick="alert('Erasure request initiated')">Request Erasure</button>
            <button class="btn btn-sm" style="width:100%;margin-bottom:5px;justify-content:center" onclick="alert('Data redacted')">Redact Data</button>
            <button class="btn btn-sm" style="width:100%;justify-content:center" onclick="alert('SAR export started')">SAR Export</button>
          </div>`:''}
          ${mergedFromBlock}
          ${linkedBlock}
          ${otherTickets.length?`
          <div class="ts-section">
            <div class="ts-heading">Other tickets (${otherTickets.length})</div>
            ${otherTickets.map(ot=>`
              <div class="other-ticket" onclick="openTicket('${ot.id}')">
                <div class="other-ticket-subj">${ot.subject}</div>
                <span class="tag tag-${ot.status}">${ot.status}</span>
              </div>`).join('')}
          </div>`:''}
          ${activityBlock}
        </div>
      </div>
    </div>`;
}

function setComposeTab(tab, id) { COMPOSE_TAB = tab; openTicket(id); }

function getTicketTimes(t) {
  const msgs = t.msgs || [];
  const customerMsgs = msgs.filter(m => m.r === 'customer');
  const agentMsgs = msgs.filter(m => m.r === 'agent' || m.r === 'ai');

  let firstResp = '—';
  if (customerMsgs.length && agentMsgs.length) {
    const cust = customerMsgs[0];
    const agentAfter = agentMsgs.find(a => msgs.indexOf(a) > msgs.indexOf(cust));
    if (agentAfter && /^\d+:\d+/.test(cust.ts) && /^\d+:\d+/.test(agentAfter.ts)) {
      const [ch, cm] = cust.ts.split(':').map(Number);
      const [ah, am] = agentAfter.ts.split(':').map(Number);
      const diff = Math.max(0, (ah - ch) * 60 + (am - cm));
      firstResp = diff === 0 ? '< 1m' : diff < 60 ? `${diff}m` : `${Math.floor(diff/60)}h ${diff%60}m`;
    }
  }

  let age = '—';
  if (t.created) {
    const created = new Date(t.created);
    const today = new Date('2025-04-16');
    const days = Math.max(0, Math.floor((today - created) / 86400000));
    age = days === 0 ? 'today' : days === 1 ? '1 day' : `${days} days`;
  }

  return { firstResp, age, created: t.created || '—', lastUpdate: t.updated || '—' };
}

function getSuggestedKB(t) {
  const tokens = (t.subject || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3);
  const cat = (t.category || '').toLowerCase();
  const scored = KB_ARTICLES.map(a => {
    let score = 0;
    if (a.category.toLowerCase() === cat) score += 3;
    const text = (a.title + ' ' + a.body).toLowerCase();
    tokens.forEach(tok => { if (text.includes(tok)) score += 1; });
    return { a, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
  return scored.map(s => s.a);
}

function toggleWatch(id) {
  const t = TICKETS.find(x => x.id === id);
  if (!t || !SESSION) return;
  if (!t.followers) t.followers = [];
  const idx = t.followers.indexOf(SESSION.name);
  if (idx >= 0) t.followers.splice(idx, 1);
  else t.followers.push(SESSION.name);
  openTicket(id);
}

function insertMacro(ticketId, idx) {
  const r = CANNED_RESPONSES[idx];
  if (!r) return;
  const t = TICKETS.find(x => x.id === ticketId);
  const cust = t ? CUSTOMERS.find(c => c.id === t.customerId) : null;
  const text = r.text.replace('{name}', cust ? cust.first : 'there');
  const el = document.getElementById('compose-' + ticketId);
  if (el) {
    el.value = el.value ? `${el.value}\n\n${text}` : text;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }
  closeModal();
}

function changeTicketStatus(id, val) {
  const t = TICKETS.find(x => x.id === id);
  if (!t || t.status === val) return;
  const prevSla = t.sla;
  logTicketEvent(id, 'status', `Status: ${t.status} → ${val}`);
  t.status = val;
  refreshTicketSLA(t);
  if (val === 'resolved' && !t.csatRequestedAt && !t.csat) {
    t.csatRequestedAt = new Date().toISOString().slice(0, 10);
    logTicketEvent(id, 'system', 'CSAT survey sent to customer');
  }
  updateNavBadges();
  if (CURRENT_TICKET === id) openTicket(id);
  if (val === 'resolved')   fireWebhook('ticket.resolved',  ticketPayload(t));
  if (val === 'escalated')  fireWebhook('ticket.escalated', ticketPayload(t));
  if (prevSla !== 'breach' && t.sla === 'breach') fireWebhook('sla.breach', ticketPayload(t));
}
function quickStatus(id, val) { changeTicketStatus(id, val); }
function addTicketTag(id, raw) {
  const tag = String(raw || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (!tag) return;
  const t = TICKETS.find(x => x.id === id); if (!t) return;
  if (!t.tags) t.tags = [];
  if (!t.tags.includes(tag)) {
    t.tags.push(tag);
    logTicketEvent(id, 'tag', `Tagged: ${tag}`);
    const lib = TAG_LIBRARY.find(x => x.tag === tag);
    if (lib) lib.count++;
    else TAG_LIBRARY.push({ tag, count: 1, type: 'manual', conf: null });
  }
  openTicket(id);
}
function removeTicketTag(id, tag) {
  const t = TICKETS.find(x => x.id === id); if (!t) return;
  if ((t.tags || []).includes(tag)) {
    logTicketEvent(id, 'tag', `Tag removed: ${tag}`);
  }
  t.tags = (t.tags || []).filter(x => x !== tag);
  const lib = TAG_LIBRARY.find(x => x.tag === tag);
  if (lib && lib.count > 0) lib.count--;
  openTicket(id);
}
function changeTicketPriority(id, val) {
  const t = TICKETS.find(x => x.id === id);
  if (!t || t.priority === val) return;
  logTicketEvent(id, 'priority', `Priority: ${t.priority} → ${val}`);
  t.priority = val;
  refreshTicketSLA(t);
  if (CURRENT_TICKET === id) openTicket(id);
}
function changeTicketAgent(id, val) {
  const t = TICKETS.find(x => x.id === id);
  if (!t) return;
  const old = t.agent || 'Unassigned';
  if (old === val) return;
  logTicketEvent(id, 'agent', `Reassigned: ${old} → ${val}`);
  t.agent = val;
  if (CURRENT_TICKET === id) openTicket(id);
  fireWebhook('ticket.assigned', { ...ticketPayload(t), previousAgent: old });
}

function acceptAITag(ticketId, tagName) {
  const t = TICKETS.find(x=>x.id===ticketId);
  const at = t.aiTags.find(x=>x.tag===tagName);
  if(at) { at.accepted=true; t.tags.push(tagName); }
  openTicket(ticketId);
}
function acceptAllAITags(ticketId) {
  const t = TICKETS.find(x=>x.id===ticketId);
  t.aiTags.forEach(at => { if(!at.accepted){ at.accepted=true; t.tags.push(at.tag); } });
  openTicket(ticketId);
}
function prevNextTicket(dir) {
  const idx = TICKETS.findIndex(t => t.id === CURRENT_TICKET);
  const next = TICKETS[idx + dir];
  if (next) openTicket(next.id);
}


function onComposeInput(id) {
  const el = document.getElementById('compose-' + id);
  if (!el) return;
  saveDraft(id, el.value);
  const cc = document.getElementById('char-count-' + id);
  if (cc) cc.textContent = `${el.value.length} chars`;
  const ds = document.getElementById('draft-status-' + id);
  if (ds) ds.textContent = el.value.length ? 'Draft saved' : '';
  if (COMPOSE_TAB === 'note') updateMentionDropdown(id, el);
  else hideMentionDropdown();
}


function insertVar(id, token) {
  const t = TICKETS.find(x => x.id === id);
  const cust = t ? CUSTOMERS.find(c => c.id === t.customerId) : null;
  let val = token;
  if (token === '{name}'   && cust) val = cust.first;
  else if (token === '{ticket}')    val = id;
  else if (token === '{brand}' && cust) val = cust.brand;
  else if (token === '{agent}' && t) val = t.agent || '';
  const el = document.getElementById('compose-' + id);
  if (!el) return;
  el.focus();
  const start = el.selectionStart || 0;
  const end   = el.selectionEnd   || 0;
  el.value = el.value.slice(0, start) + val + el.value.slice(end);
  const pos = start + val.length;
  el.setSelectionRange(pos, pos);
  onComposeInput(id);
}

function toggleAIMenu(id) {
  const m = document.getElementById('ai-menu-' + id);
  if (!m) return;
  document.getElementById('send-menu-' + id)?.style.setProperty('display', 'none');
  m.style.display = m.style.display === 'block' ? 'none' : 'block';
}
function hideAIMenu(id)  { const m = document.getElementById('ai-menu-'   + id); if (m) m.style.display = 'none'; }
function toggleSendMenu(id) {
  const m = document.getElementById('send-menu-' + id);
  if (!m) return;
  document.getElementById('ai-menu-' + id)?.style.setProperty('display', 'none');
  m.style.display = m.style.display === 'block' ? 'none' : 'block';
}
function hideSendMenu(id) { const m = document.getElementById('send-menu-' + id); if (m) m.style.display = 'none'; }

function sendComposeAnd(id, status) {
  hideSendMenu(id);
  sendCompose(id);
  changeTicketStatus(id, status);
  if (CURRENT_TICKET === id) openTicket(id);
}

function showSentTextModal(ticketId, msgIdx) {
  const t = TICKETS.find(x => x.id === ticketId);
  const m = t && t.msgs && t.msgs[msgIdx];
  if (!m) return;
  showModal(`Sent to customer · ${m.translatedTo || 'translated'}`,
    `<div style="font-size:13px;color:var(--ink);line-height:1.6;white-space:pre-wrap;word-wrap:break-word">${escHtml(m.t || '')}</div>`,
    null, null);
}

async function sendCompose(id) {
  const el = document.getElementById(`compose-${id}`);
  const txt = el.value.trim(); if (!txt) return;
  const t = TICKETS.find(x => x.id === id);
  if (!t) return;

  // Auto-translate outgoing replies (not internal notes) when toggle is on and we know the customer's language
  let outgoing = txt;
  let original = null;
  let translatedTo = null;
  const shouldAutoTranslate = COMPOSE_TAB !== 'note'
    && t.autoTranslateReplies
    && t.detectedCustomerLang
    && t.detectedCustomerLang.toLowerCase() !== AGENT_PREFERRED_LANG.toLowerCase()
    && AI_API_KEY;
  if (shouldAutoTranslate) {
    AI_THINKING = true;
    try {
      if (CURRENT_TICKET === id) openTicket(id);
      const res = await translateText(txt, t.detectedCustomerLang);
      if (res.translation) {
        outgoing = res.translation;
        original = txt;
        translatedTo = t.detectedCustomerLang;
      }
    } finally {
      AI_THINKING = false;
    }
  }

  const isNote = COMPOSE_TAB === 'note';
  const mentions = isNote ? parseMentions(outgoing) : null;
  t.msgs.push({
    from: SESSION.name,
    r: isNote ? 'note' : 'agent',
    t: outgoing,
    tOriginal: original,
    translatedTo,
    mentions,
    ts: new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}),
  });
  el.value = '';
  clearDraft(id);
  onComposeInput(id);
  if (CURRENT_TICKET === id) openTicket(id);
}

function showNewTicketModal(templateId) {
  const cats = [...new Set([...TICKETS.map(t=>t.category), ...TICKET_TEMPLATES.map(t=>t.category)])];
  const tpl = templateId ? TICKET_TEMPLATES.find(t => t.id === templateId) : null;
  const esc = s => String(s||'').replace(/"/g,'&quot;');
  const tplOptions = TICKET_TEMPLATES.map(t => `<option value="${escAttr(t.id)}" ${tpl?.id===t.id?'selected':''}>${escHtml(t.name)}</option>`).join('');
  const req = key => isFieldRequired('ticket', key) ? ' <span style="color:var(--red);font-weight:500" title="Required">*</span>' : '';
  const visible = key => isFieldVisible('ticket', key);
  const customerRow = visible('customerId')
    ? `<div class="form-row"><label class="form-label">Customer ID${req('customerId')}</label><input class="form-input" id="nt-cust" placeholder="M001"/></div>`
    : '';
  const categoryRow = visible('category')
    ? `<div class="form-row"><label class="form-label">Category${req('category')}</label>
        <select class="form-input" id="nt-cat">${cats.map(c=>`<option ${tpl?.category===c?'selected':''}>${c}</option>`).join('')}</select>
      </div>`
    : '';
  const priorityRow = visible('priority')
    ? `<div class="form-row"><label class="form-label">Priority${req('priority')}</label>
        <select class="form-input" id="nt-pri">${['normal','high','urgent','low'].map(p => `<option ${tpl?.priority===p?'selected':''}>${p}</option>`).join('')}</select>
      </div>`
    : '';
  const agentRow = visible('agent')
    ? `<div class="form-row"><label class="form-label">Assign to${req('agent')}</label>
        <select class="form-input" id="nt-agent">
          <option value="__auto__">Auto (apply rules)</option>
          ${AGENTS.map(a=>`<option value="${escAttr(a.name)}">${escHtml(a.name)}${isAgentOOO(a.name) ? ' (OOO)' : ''}</option>`).join('')}
        </select>
      </div>`
    : '';
  const messageRow = visible('message')
    ? `<div class="form-row"><label class="form-label">Message${req('message')}</label><textarea class="form-input" id="nt-msg" placeholder="First message…">${escHtml(tpl?.body || '')}</textarea></div>`
    : '';
  showModal('New Ticket', `
    ${TICKET_TEMPLATES.length ? `
    <div class="form-row">
      <label class="form-label">Start from template (optional)</label>
      <select class="form-input" id="nt-template" onchange="ntApplyTemplate(this.value)">
        <option value="">— Blank ticket —</option>
        ${tplOptions}
      </select>
    </div>` : ''}
    ${customerRow || categoryRow ? `<div class="form-grid">${customerRow}${categoryRow}</div>` : ''}
    ${visible('subject') ? `<div class="form-row"><label class="form-label">Subject${req('subject')}</label><input class="form-input" id="nt-subj" value="${esc(tpl?.subject)}" placeholder="Describe the issue…"/></div>` : ''}
    ${priorityRow || agentRow ? `<div class="form-grid">${priorityRow}${agentRow}</div>` : ''}
    ${messageRow}
  `, () => {
    const subj = document.getElementById('nt-subj')?.value.trim() || '';
    if (visible('subject') && isFieldRequired('ticket', 'subject') && !subj) { alert('Subject is required.'); return; }
    const custInput = document.getElementById('nt-cust');
    const custId = custInput ? (custInput.value.trim() || 'M001') : 'M001';
    if (visible('customerId') && isFieldRequired('ticket', 'customerId') && !custInput?.value.trim()) {
      alert('Customer is required.'); return;
    }
    const msgEl = document.getElementById('nt-msg');
    const msg = msgEl ? msgEl.value.trim() : '';
    if (visible('message') && isFieldRequired('ticket', 'message') && !msg) {
      alert('First message is required.'); return;
    }
    if (visible('category') && isFieldRequired('ticket', 'category') && !document.getElementById('nt-cat')?.value) {
      alert('Category is required.'); return;
    }
    if (visible('priority') && isFieldRequired('ticket', 'priority') && !document.getElementById('nt-pri')?.value) {
      alert('Priority is required.'); return;
    }
    if (visible('agent') && isFieldRequired('ticket', 'agent')) {
      const v = document.getElementById('nt-agent')?.value;
      if (!v || v === '__auto__') { alert('Assignee is required (Auto does not satisfy a required assignment).'); return; }
    }
    // parseInt on non-numeric IDs returns NaN; filter them out so a stray
    // ticket like "TK-foo" can't poison Math.max into NaN.
    const ticketNums = TICKETS.map(t => parseInt((t.id||'').split('-')[1] || '0', 10)).filter(n => Number.isFinite(n));
    const newId = 'TK-' + String(Math.max(0, ...ticketNums) + 1).padStart(3,'0');
    const agentPick = document.getElementById('nt-agent')?.value || '__auto__';
    TICKETS.unshift({
      id:newId, subject:subj, customerId:custId,
      status:'open',
      priority: document.getElementById('nt-pri')?.value || 'normal',
      category: document.getElementById('nt-cat')?.value || 'Technical',
      agent:agentPick === '__auto__' ? '' : agentPick,
      created:new Date().toISOString().slice(0,10), updated:'just now',
      sla:'ok', tags:[], aiTags:[], csat:null,
      msgs: msg ? [{from:SESSION.name,r:'agent',t:msg,ts:new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}] : [],
    });
    if (agentPick === '__auto__') applyAssignmentRules(TICKETS[0]);
    refreshTicketSLA(TICKETS[0]);
    fireWebhook('ticket.created', ticketPayload(TICKETS[0]));
    closeModal(); renderPage('tickets');
  }, 'Create Ticket');
}

function ntApplyTemplate(id) {
  const t = id ? TICKET_TEMPLATES.find(x => x.id === id) : null;
  const subj = document.getElementById('nt-subj');
  const cat  = document.getElementById('nt-cat');
  const pri  = document.getElementById('nt-pri');
  const msg  = document.getElementById('nt-msg');
  if (!t) {
    if (subj) subj.value = '';
    if (msg) msg.value = '';
    return;
  }
  if (subj) subj.value = t.subject || '';
  if (msg) msg.value = t.body || '';
  if (cat && t.category) {
    [...cat.options].forEach(o => { if (o.value === t.category) cat.value = t.category; });
  }
  if (pri && t.priority) pri.value = t.priority;
}

// ─── Ticket Templates page ───────────────────────────────────────────────────
let TT_QUERY = '';

function renderTicketTemplates() {
  const admin = isAdmin();
  let list = [...TICKET_TEMPLATES];
  if (TT_FILTER_CAT !== 'all') list = list.filter(t => t.category === TT_FILTER_CAT);
  if (TT_QUERY.trim()) {
    const q = TT_QUERY.toLowerCase();
    list = list.filter(t => t.name.toLowerCase().includes(q) || t.subject.toLowerCase().includes(q) || (t.body||'').toLowerCase().includes(q) || (t.category||'').toLowerCase().includes(q));
  }
  const total = TICKET_TEMPLATES.length;
  const cats = [...new Set(TICKET_TEMPLATES.map(t => t.category))];

  const rows = list.map(t => `
    <tr>
      <td class="bold">${t.id}</td>
      <td style="font-weight:500;color:var(--ink)">${escHtml(t.name)}</td>
      <td><span class="tag tag-neutral" style="font-size:10px">${escHtml(t.category)}</span></td>
      <td><span class="tag tag-${t.priority}" style="font-size:10px">${t.priority}</span></td>
      <td style="font-size:12px;color:var(--ink2);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(t.subject)}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-sm btn-solid" onclick="showNewTicketModal('${escAttr(t.id)}')">Use</button>
        ${admin ? `
          <button class="btn btn-sm" onclick="ttEdit('${escAttr(t.id)}')">Edit</button>
          <button class="btn btn-sm" onclick="ttDuplicate('${escAttr(t.id)}')">Copy</button>
          <button class="btn btn-sm btn-danger" onclick="ttDelete('${escAttr(t.id)}')">Delete</button>` : ''}
      </td>
    </tr>`).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Ticket Templates</div>
        ${admin ? `<button class="btn btn-solid btn-sm" onclick="ttNew()">+ New Template</button>` : ''}
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Templates</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${cats.length}</div><div class="kpi-l">Categories</div></div>
        <div class="kpi"><div class="kpi-n c-red">${TICKET_TEMPLATES.filter(t => t.priority==='urgent' || t.priority==='high').length}</div><div class="kpi-l">High/urgent defaults</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${Math.round(TICKET_TEMPLATES.reduce((s,t)=>s+(t.body||'').length,0)/(total||1))}</div><div class="kpi-l">Avg body chars</div></div>
      </div>
      <div class="filter-bar">
        <span class="filter-label">Filter</span>
        <input class="filter-select" placeholder="Search templates…" style="width:240px" value="${TT_QUERY}" oninput="ttSetQuery(this.value)" id="tt-search"/>
        <select class="filter-select" onchange="TT_FILTER_CAT=this.value;renderPage('ticket-templates')">
          <option value="all" ${TT_FILTER_CAT==='all'?'selected':''}>All categories</option>
          ${cats.map(c => `<option value="${c}" ${TT_FILTER_CAT===c?'selected':''}>${c}</option>`).join('')}
        </select>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${total}</span>
      </div>
      <div class="page-scroll">
        <table class="tbl">
          <thead><tr><th>ID</th><th>Name</th><th>Category</th><th>Priority</th><th>Subject preview</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${list.length===0 ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No templates match</div><div class="empty-line"></div></div>` : ''}
        <div style="margin-top:14px;font-size:11px;color:var(--ink3);line-height:1.5">Click <strong style="color:var(--ink2)">Use</strong> to open the New Ticket modal pre-filled from the template. The same picker is also available inside the regular New Ticket flow.</div>
      </div>
    </div>`;
}

function ttSetQuery(q) {
  TT_QUERY = q;
  renderPage('ticket-templates');
  const input = document.getElementById('tt-search');
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

function ttFormBody(t) {
  const cats = [...new Set([...TICKET_TEMPLATES.map(x => x.category), ...TICKETS.map(x => x.category)])];
  const esc = s => String(s||'').replace(/"/g,'&quot;');
  return `
    <div class="form-row"><label class="form-label">Name</label><input class="form-input" id="tt-name" value="${esc(t?.name)}" placeholder="e.g. Outage report"/></div>
    <div class="form-grid">
      <div class="form-row"><label class="form-label">Category</label>
        <input class="form-input" id="tt-cat" list="tt-cat-list" value="${esc(t?.category)}" placeholder="Account / Billing / Technical…"/>
        <datalist id="tt-cat-list">${cats.map(c => `<option value="${escHtml(c)}">`).join('')}</datalist>
      </div>
      <div class="form-row"><label class="form-label">Default priority</label>
        <select class="form-input" id="tt-pri">${['low','normal','high','urgent'].map(p => `<option value="${p}" ${(t?.priority||'normal')===p?'selected':''}>${p}</option>`).join('')}</select>
      </div>
    </div>
    <div class="form-row"><label class="form-label">Subject (template)</label><input class="form-input" id="tt-subj" value="${esc(t?.subject)}" placeholder="Use [placeholders] for fields agents fill in"/></div>
    <div class="form-row"><label class="form-label">Body</label><textarea class="form-input" id="tt-body" style="min-height:140px;font-family:'Inter',sans-serif" placeholder="Initial ticket message or agent guidance">${escHtml(t?.body||'')}</textarea></div>`;
}

function ttNextId() {
  const max = Math.max(0, ...TICKET_TEMPLATES.map(x => parseInt((x.id||'').split('-')[1] || '0', 10)));
  return 'TT-' + String(max + 1).padStart(3, '0');
}

function ttNew() {
  if (!isAdmin()) return;
  showModal('New ticket template', ttFormBody(null), () => {
    const name = document.getElementById('tt-name').value.trim();
    const category = document.getElementById('tt-cat').value.trim() || 'General';
    const priority = document.getElementById('tt-pri').value;
    const subject = document.getElementById('tt-subj').value.trim();
    const body = document.getElementById('tt-body').value;
    if (!name || !subject) return;
    TICKET_TEMPLATES.unshift({ id: ttNextId(), name, category, priority, subject, body });
    closeModal(); renderPage('ticket-templates');
  }, 'Create');
}

function ttEdit(id) {
  if (!isAdmin()) return;
  const t = TICKET_TEMPLATES.find(x => x.id === id); if (!t) return;
  showModal(`Edit ${t.id}`, ttFormBody(t), () => {
    const name = document.getElementById('tt-name').value.trim();
    const category = document.getElementById('tt-cat').value.trim() || 'General';
    const priority = document.getElementById('tt-pri').value;
    const subject = document.getElementById('tt-subj').value.trim();
    const body = document.getElementById('tt-body').value;
    if (!name || !subject) return;
    t.name = name; t.category = category; t.priority = priority; t.subject = subject; t.body = body;
    closeModal(); renderPage('ticket-templates');
  }, 'Save');
}

function ttDuplicate(id) {
  if (!isAdmin()) return;
  const orig = TICKET_TEMPLATES.find(x => x.id === id); if (!orig) return;
  TICKET_TEMPLATES.unshift({ ...orig, id: ttNextId(), name: orig.name + ' (copy)' });
  renderPage('ticket-templates');
}

function ttDelete(id) {
  if (!isAdmin()) return;
  const t = TICKET_TEMPLATES.find(x => x.id === id); if (!t) return;
  showModal('Delete template', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${escHtml(t.name)}</strong>?</div>`, () => {
    const i = TICKET_TEMPLATES.findIndex(x => x.id === id);
    if (i >= 0) TICKET_TEMPLATES.splice(i, 1);
    closeModal(); renderPage('ticket-templates');
  }, 'Delete');
}

// ─── Customers ────────────────────────────────────────────────────────────────
// ─── Customer table column state ─────────────────────────────────────────────

function getCustColumns() {
  const customCols = CUSTOM_FIELDS.map(f=>({id:'cf_'+f.id,label:f.label,fixed:false,isCustom:true,cfId:f.id}));
  customCols.forEach(cc=>{
    if(!CUST_COLUMNS.find(c=>c.id===cc.id)) CUST_COLUMNS.push({...cc,visible:false});
  });
  CUST_COLUMNS = CUST_COLUMNS.filter(c=>!c.isCustom||CUSTOM_FIELDS.find(f=>'cf_'+f.id===c.id));
  return CUST_COLUMNS;
}

function custCellValue(c, colId) {
  if(colId==='id') return `<td class="bold">${c.id}</td>`;
  if(colId==='name') return `<td style="font-weight:500;color:var(--ink)">${c.first} ${c.last}</td>`;
  if(colId==='username') return `<td style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3)">${c.username}</td>`;
  if(colId==='brand') return `<td>${c.brand}</td>`;
  if(colId==='vip') return `<td><span class="vip-badge vip-${c.vip.toLowerCase()}">${c.vip}</span></td>`;
  if(colId==='jurisdiction') return `<td style="font-family:'DM Mono',monospace;font-size:11px">${c.jurisdiction}</td>`;
  if(colId==='consent') return `<td><span class="tag ${c.consent?'tag-resolved':'tag-gdpr'}">${c.consent?'Yes':'No'}</span></td>`;
  if(colId==='kyc') return `<td><span class="tag ${c.kyc==='Verified'?'tag-resolved':'tag-pending'}">${c.kyc}</span></td>`;
  if(colId.startsWith('cf_')) { const cfId=colId.slice(3); return `<td style="font-size:12px;color:var(--ink2)">${c.custom?.[cfId]||'—'}</td>`; }
  return '<td>—</td>';
}

function buildCustRows(list) {
  const cols = getCustColumns().filter(c=>c.visible);
  return list.map(c => {
    const checked = CUSTOMER_SELECTED_IDS.has(c.id);
    return `<tr onclick="openCustomerProfile('${c.id}')" style="cursor:pointer${checked?';background:var(--purple-lt)':''}">
      <td style="width:32px;padding-right:0" onclick="event.stopPropagation()">
        <input type="checkbox" ${checked?'checked':''} onchange="toggleCustSelected('${c.id}')" style="cursor:pointer;accent-color:var(--purple)" />
      </td>
      ${cols.map(col=>custCellValue(c,col.id)).join('')}
    </tr>`;
  }).join('');
}

function buildCustHeaders() {
  const cols = getCustColumns().filter(c=>c.visible);
  const ids = applyCustFilters().map(c => c.id);
  const allSelected = ids.length > 0 && ids.every(id => CUSTOMER_SELECTED_IDS.has(id));
  const checkboxHeader = `<th style="width:32px;padding-right:0" onclick="event.stopPropagation()">
    <input type="checkbox" ${allSelected?'checked':''} onchange="toggleAllCustomers()" style="cursor:pointer;accent-color:var(--purple)" title="Select all in view"/>
  </th>`;
  return checkboxHeader + cols.map((col,i)=>`<th draggable="true" ondragstart="CUST_DRAG_COL=${i}" ondragover="event.preventDefault()" ondrop="dropCustCol(${i})" style="cursor:grab;user-select:none;white-space:nowrap" title="Drag to reorder">${col.label} <span style="opacity:.3;font-size:10px">⠿</span></th>`).join('');
}

function dropCustCol(targetIdx) {
  const vis = getCustColumns().filter(c=>c.visible);
  const all = getCustColumns();
  if(CUST_DRAG_COL===null||CUST_DRAG_COL===targetIdx) return;
  const src=vis[CUST_DRAG_COL], tgt=vis[targetIdx];
  if(!src||!tgt||src.fixed||tgt.fixed) return;
  const si=all.indexOf(src), ti=all.indexOf(tgt);
  all.splice(si,1); all.splice(ti,0,src);
  CUST_DRAG_COL=null;
  refreshCustTable(CUSTOMERS);
}

function refreshCustTable(list) {
  const thead = document.getElementById('cust-thead');
  const tbody = document.getElementById('cust-tbody');
  if (thead) thead.innerHTML = buildCustHeaders();
  if (tbody) {
    const groups = groupCustomersBy(list, CUST_GROUP_BY);
    const groupHeader = key => `<tr style="background:var(--off2)"><td colspan="20" style="padding:8px 14px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink3)">${key}</td></tr>`;
    tbody.innerHTML = groups.map(g =>
      (g.key !== null ? groupHeader(`${g.key} · ${g.items.length}`) : '') + buildCustRows(g.items)
    ).join('');
  }
}

function showColumnPanel() {
  const cols=getCustColumns();
  showModal('Manage columns', `
    <div style="font-size:12px;color:var(--ink3);margin-bottom:14px">Toggle columns on/off. Drag column headers in the table to reorder.</div>
    <div style="display:flex;flex-direction:column;gap:6px">
      ${cols.map((col,i)=>`
        <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;border:1px solid var(--rule);border-radius:var(--r);background:var(--off2)">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:13px;font-weight:500;color:var(--ink)">${col.label}</span>
            ${col.isCustom?`<span style="font-size:10px;color:var(--purple);background:var(--purple-lt);padding:1px 6px;border-radius:3px">Custom</span>`:''}
            ${col.fixed?`<span style="font-size:10px;color:var(--ink3)">(always shown)</span>`:''}
          </div>
          <label class="toggle">
            <input type="checkbox" ${col.visible?'checked':''} ${col.fixed?'disabled':''} onchange="CUST_COLUMNS[${i}].visible=this.checked;refreshCustTable(CUSTOMERS)">
            <span class="toggle-slider"></span>
          </label>
        </div>`).join('')}
    </div>
  `, null, null);
}

let CUST_QUERY = '';
let CUST_VIP_FILTER = 'all';
let CUST_BRAND_FILTER = 'all';
let CUST_VIEW_FILTER = 'all';
let CUST_GROUP_BY = 'none';
const CUSTOMER_SELECTED_IDS = new Set();

function applyCustFilters() {
  let list = [...CUSTOMERS];
  // Hide merged-into duplicates by default; the "Merged" view chip surfaces them on demand.
  if (CUST_VIEW_FILTER === 'merged') list = list.filter(c => c.mergedInto);
  else                               list = list.filter(c => !c.mergedInto);
  if (CUST_VIEW_FILTER === 'premium')         list = list.filter(c => c.vip === 'Platinum' || c.vip === 'Gold');
  else if (CUST_VIEW_FILTER === 'kyc-pending') list = list.filter(c => c.kyc !== 'Verified');
  else if (CUST_VIEW_FILTER === 'no-consent')  list = list.filter(c => !c.consent);
  else if (CUST_VIEW_FILTER === 'at-risk')     list = list.filter(c => TICKETS.some(t => t.customerId === c.id && (t.sla === 'breach' || t.status === 'escalated')));
  if (CUST_QUERY.trim()) {
    const q = CUST_QUERY.toLowerCase();
    list = list.filter(c => (c.first+' '+c.last+' '+c.username+' '+c.id+' '+c.email+' '+c.brand).toLowerCase().includes(q));
  }
  if (CUST_VIP_FILTER !== 'all')   list = list.filter(c => c.vip === CUST_VIP_FILTER);
  if (CUST_BRAND_FILTER !== 'all') list = list.filter(c => c.brand === CUST_BRAND_FILTER);
  return list;
}

function groupCustomersBy(list, by) {
  if (by === 'none') return [{ key: null, items: list }];
  const groups = new Map();
  list.forEach(c => {
    let key = (c[by] || '—') + '';
    if (by === 'consent') key = c.consent ? 'Consent given' : 'No consent';
    groups.has(key) || groups.set(key, []);
    groups.get(key).push(c);
  });
  return [...groups.entries()].map(([key, items]) => ({ key, items }));
}

function setCustView(v) { CUST_VIEW_FILTER = v; renderPage('customers'); }
function setCustGroupBy(v) { CUST_GROUP_BY = v; renderPage('customers'); }

function toggleCustSelected(id) {
  if (CUSTOMER_SELECTED_IDS.has(id)) CUSTOMER_SELECTED_IDS.delete(id);
  else CUSTOMER_SELECTED_IDS.add(id);
  renderPage('customers');
}

function toggleAllCustomers() {
  const ids = applyCustFilters().map(c => c.id);
  const all = ids.length > 0 && ids.every(id => CUSTOMER_SELECTED_IDS.has(id));
  if (all) ids.forEach(id => CUSTOMER_SELECTED_IDS.delete(id));
  else ids.forEach(id => CUSTOMER_SELECTED_IDS.add(id));
  renderPage('customers');
}

function clearCustSelection() { CUSTOMER_SELECTED_IDS.clear(); renderPage('customers'); }

function bulkSetCustVIP(v) {
  if (!v || CUSTOMER_SELECTED_IDS.size === 0) return;
  CUSTOMERS.forEach(c => { if (CUSTOMER_SELECTED_IDS.has(c.id)) c.vip = v; });
  CUSTOMER_SELECTED_IDS.clear();
  renderPage('customers');
}
function bulkSetCustConsent(v) {
  if (!v || CUSTOMER_SELECTED_IDS.size === 0) return;
  CUSTOMERS.forEach(c => { if (CUSTOMER_SELECTED_IDS.has(c.id)) c.consent = v === 'yes'; });
  CUSTOMER_SELECTED_IDS.clear();
  renderPage('customers');
}
function bulkDeleteCustomers() {
  const n = CUSTOMER_SELECTED_IDS.size;
  if (n === 0) return;
  showModal(`Delete ${n} customer${n===1?'':'s'}`, `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${n}</strong> customer${n===1?'':'s'}? Tickets they own will be orphaned.</div>`, () => {
    for (let i = CUSTOMERS.length - 1; i >= 0; i--) {
      if (CUSTOMER_SELECTED_IDS.has(CUSTOMERS[i].id)) CUSTOMERS.splice(i, 1);
    }
    CUSTOMER_SELECTED_IDS.clear();
    closeModal();
    renderPage('customers');
  }, 'Delete');
}

function exportCustomerList() {
  const list = applyCustFilters();
  const headers = ['ID','First','Last','Username','Email','Mobile','Brand','VIP','Jurisdiction','Consent','KYC','Since'];
  const rows = list.map(c => [c.id, c.first, c.last, c.username, c.email, c.mobile, c.brand, c.vip, c.jurisdiction, c.consent ? 'Yes' : 'No', c.kyc, c.since]);
  const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `customers-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
function filterCustomers(q) { CUST_QUERY = q; refreshCustTable(applyCustFilters()); refreshCustCounter(); }
function refreshCustCounter() {
  const el = document.getElementById('cust-counter'); if (!el) return;
  el.textContent = `${applyCustFilters().length} of ${CUSTOMERS.length}`;
}
function custSetVIP(v)   { CUST_VIP_FILTER = v;   renderPage('customers'); }
function custSetBrand(v) { CUST_BRAND_FILTER = v; renderPage('customers'); }

function renderCustomers() {
  if (CUSTOMER_SELECTED) return renderCustomerDetail(CUSTOMER_SELECTED);
  getCustColumns();
  const filtered = applyCustFilters();
  const total = CUSTOMERS.length;
  const brands = [...new Set(CUSTOMERS.map(c => c.brand))];
  const vipCounts = { Platinum:0, Gold:0, Silver:0, Bronze:0 };
  CUSTOMERS.forEach(c => { if (vipCounts[c.vip] !== undefined) vipCounts[c.vip]++; });
  const premium = vipCounts.Platinum + vipCounts.Gold;
  const avgPerCust = total ? (TICKETS.length / total).toFixed(1) : '0';
  const consentRate = total ? Math.round(CUSTOMERS.filter(c => c.consent).length / total * 100) : 0;

  // View chip counts
  const kycPendingN = CUSTOMERS.filter(c => c.kyc !== 'Verified').length;
  const noConsentN  = CUSTOMERS.filter(c => !c.consent).length;
  const atRiskN     = CUSTOMERS.filter(c => TICKETS.some(t => t.customerId === c.id && (t.sla === 'breach' || t.status === 'escalated'))).length;
  const mergedN = CUSTOMERS.filter(c => c.mergedInto).length;
  const views = [
    { k: 'all',         l: 'All',                         active: CUST_VIEW_FILTER === 'all' },
    { k: 'premium',     l: `Premium · ${premium}`,        active: CUST_VIEW_FILTER === 'premium' },
    { k: 'kyc-pending', l: `KYC pending · ${kycPendingN}`, active: CUST_VIEW_FILTER === 'kyc-pending' },
    { k: 'no-consent',  l: `No consent · ${noConsentN}`,  active: CUST_VIEW_FILTER === 'no-consent' },
    { k: 'at-risk',     l: `At risk · ${atRiskN}`,        active: CUST_VIEW_FILTER === 'at-risk' },
    { k: 'merged',      l: `Merged · ${mergedN}`,         active: CUST_VIEW_FILTER === 'merged' },
  ];

  const groups = groupCustomersBy(filtered, CUST_GROUP_BY);
  const groupHeader = key => `<tr style="background:var(--off2)"><td colspan="20" style="padding:8px 14px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink3)">${key}</td></tr>`;
  const tableBody = groups.map(g =>
    (g.key !== null ? groupHeader(`${g.key} · ${g.items.length}`) : '') + buildCustRows(g.items)
  ).join('');

  const bulkBar = CUSTOMER_SELECTED_IDS.size > 0 ? `
    <div style="padding:8px 20px;border-bottom:1px solid var(--rule);background:var(--purple-lt);display:flex;align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap">
      <span style="font-size:12px;color:var(--purple);font-weight:600">${CUSTOMER_SELECTED_IDS.size} selected</span>
      <select class="filter-select" onchange="bulkSetCustVIP(this.value)">
        <option value="">Set VIP tier…</option>
        <option value="Platinum">Platinum</option>
        <option value="Gold">Gold</option>
        <option value="Silver">Silver</option>
        <option value="Bronze">Bronze</option>
      </select>
      <select class="filter-select" onchange="bulkSetCustConsent(this.value)">
        <option value="">Set consent…</option>
        <option value="yes">Consent: Yes</option>
        <option value="no">Consent: No</option>
      </select>
      <button class="btn btn-sm btn-danger" onclick="bulkDeleteCustomers()">Delete</button>
      <button class="btn btn-sm" onclick="clearCustSelection()" style="margin-left:auto">Clear selection</button>
    </div>` : '';

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Customers</div>
        <button class="btn btn-sm" onclick="showColumnPanel()">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1" y="1" width="3" height="10" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="5" y="1" width="3" height="10" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="9" y="1" width="2" height="10" rx="1" stroke="currentColor" stroke-width="1.2"/></svg>
          Columns
        </button>
        <button class="btn btn-sm" onclick="showManageFieldsModal()">Fields</button>
        <button class="btn btn-sm" onclick="showCSVModal()">CSV Import</button>
        <button class="btn btn-sm" onclick="exportCustomerList()">Export CSV</button>
        <button class="btn btn-sm btn-solid" onclick="showNewCustomerModal()">+ New Customer</button>
      </div>
      <div class="kpi-bar" style="grid-template-columns:repeat(5,1fr)">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Customers</div></div>
        <div class="kpi"><div class="kpi-n c-purple">${premium}</div><div class="kpi-l">Premium VIP</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${brands.length}</div><div class="kpi-l">Brands</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${avgPerCust}</div><div class="kpi-l">Avg tickets</div></div>
        <div class="kpi"><div class="kpi-n c-green">${consentRate}%</div><div class="kpi-l">Consent</div></div>
      </div>
      ${bulkBar}
      <div class="filter-bar" style="flex-wrap:wrap">
        <span class="filter-label">Filter</span>
        <input class="filter-select" placeholder="Search name, username, ID, email, brand…" style="width:240px" value="${CUST_QUERY}" oninput="filterCustomers(this.value)"/>
        <select class="filter-select" onchange="custSetVIP(this.value)">
          <option value="all"      ${CUST_VIP_FILTER==='all'?'selected':''}>All VIP tiers</option>
          <option value="Platinum" ${CUST_VIP_FILTER==='Platinum'?'selected':''}>Platinum</option>
          <option value="Gold"     ${CUST_VIP_FILTER==='Gold'?'selected':''}>Gold</option>
          <option value="Silver"   ${CUST_VIP_FILTER==='Silver'?'selected':''}>Silver</option>
          <option value="Bronze"   ${CUST_VIP_FILTER==='Bronze'?'selected':''}>Bronze</option>
        </select>
        <select class="filter-select" onchange="custSetBrand(this.value)">
          <option value="all" ${CUST_BRAND_FILTER==='all'?'selected':''}>All brands</option>
          ${brands.map(b => `<option value="${b}" ${CUST_BRAND_FILTER===b?'selected':''}>${b}</option>`).join('')}
        </select>
        <select class="filter-select" onchange="setCustGroupBy(this.value)" title="Group rows">
          <option value="none"         ${CUST_GROUP_BY==='none'?'selected':''}>No grouping</option>
          <option value="vip"          ${CUST_GROUP_BY==='vip'?'selected':''}>Group by VIP</option>
          <option value="brand"        ${CUST_GROUP_BY==='brand'?'selected':''}>Group by brand</option>
          <option value="jurisdiction" ${CUST_GROUP_BY==='jurisdiction'?'selected':''}>Group by jurisdiction</option>
          <option value="kyc"          ${CUST_GROUP_BY==='kyc'?'selected':''}>Group by KYC</option>
          <option value="consent"      ${CUST_GROUP_BY==='consent'?'selected':''}>Group by consent</option>
        </select>
        <span id="cust-counter" style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${filtered.length} of ${total}</span>
      </div>
      <div class="filter-bar" style="border-top:none;padding-top:6px;padding-bottom:10px">
        <span class="filter-label">View</span>
        ${views.map(v => `<span class="filter-tag" style="cursor:pointer;${v.active?'border-color:var(--purple);color:var(--purple);background:var(--purple-lt)':''}" onclick="setCustView('${v.k}')">${v.l}</span>`).join('')}
      </div>
      <div style="flex:1;overflow:auto">
        <table class="tbl" style="min-width:500px">
          <thead><tr id="cust-thead">${buildCustHeaders()}</tr></thead>
          <tbody id="cust-tbody">${tableBody}</tbody>
        </table>
        ${filtered.length === 0 ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No customers match</div><div class="empty-line"></div></div>` : ''}
      </div>
    </div>`;
}

function getCustomerStats(custId) {
  const tickets = TICKETS.filter(t => t.customerId === custId);
  const open = tickets.filter(t => t.status === 'open' || t.status === 'escalated').length;
  const resolved = tickets.filter(t => t.status === 'resolved').length;
  const csat = tickets.filter(t => t.csat);
  const avgCSAT = csat.length ? csat.reduce((a, t) => a + t.csat, 0) / csat.length : 0;
  return { tickets, total: tickets.length, open, resolved, csatCount: csat.length, avgCSAT };
}

function getCustomerActivity(custId) {
  const items = [];
  TICKETS.filter(t => t.customerId === custId).forEach(t => {
    (t.msgs || []).forEach(m => items.push({
      ticketId: t.id,
      from: m.from,
      role: m.r,
      text: m.t,
      ts: m.ts,
    }));
  });
  return items.slice(-15).reverse();
}

function getCustomerCommonTags(custId) {
  const counts = {};
  TICKETS.filter(t => t.customerId === custId).forEach(t => {
    (t.tags || []).forEach(tag => { counts[tag] = (counts[tag] || 0) + 1; });
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
}

function getCustomerRisk(c) {
  const tickets = TICKETS.filter(t => t.customerId === c.id);
  const flags = [];
  const breaches = tickets.filter(t => t.sla === 'breach').length;
  if (breaches > 0) flags.push({ level: 'high', text: `${breaches} SLA breach${breaches>1?'es':''}` });
  const escalated = tickets.filter(t => t.status === 'escalated').length;
  if (escalated > 0) flags.push({ level: 'high', text: `${escalated} escalated` });
  if (tickets.filter(t => t.status === 'gdpr').length > 0) flags.push({ level: 'high', text: 'Active GDPR request' });
  if (!c.consent) flags.push({ level: 'medium', text: 'No marketing consent' });
  if (c.kyc !== 'Verified') flags.push({ level: 'medium', text: `KYC ${c.kyc}` });
  return flags;
}

function addCustomerNote(custId) {
  showModal('Add internal note', `<div class="form-row"><label class="form-label">Note</label><textarea class="form-input" id="cn-text" style="min-height:120px;font-family:'Inter',sans-serif" placeholder="Context the team should know about this customer…"></textarea></div>`, () => {
    const text = document.getElementById('cn-text').value.trim();
    if (!text) return;
    const c = CUSTOMERS.find(x => x.id === custId);
    if (!c) return;
    if (!c.notes) c.notes = [];
    c.notes.unshift({
      author: SESSION?.name || 'Unknown',
      ts: new Date().toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }),
      text,
    });
    closeModal(); renderPage('customers');
  }, 'Add note');
}

function deleteCustomerNote(custId, idx) {
  const c = CUSTOMERS.find(x => x.id === custId);
  if (!c || !c.notes) return;
  c.notes.splice(idx, 1);
  renderPage('customers');
}

function openCustomerProfile(id) { CUSTOMER_SELECTED = id; renderPage('customers'); }
function closeCustomerProfile()  { CUSTOMER_SELECTED = null; renderPage('customers'); }

// ─── Customer merge ─────────────────────────────────────────────────────────
// Combines a duplicate customer record into a primary. Tickets reassign their
// customerId, notes copy across, and missing profile fields are pulled from
// the source if the primary's value was empty. Each affected ticket is tagged
// with `preMergeCustomerId` so unmergeCustomer can reliably restore them.
function showMergeCustomerModal(custId) {
  const src = CUSTOMERS.find(x => x.id === custId);
  if (!src) return;
  if (src.mergedInto) { alert(`Already merged into ${src.mergedInto}.`); return; }
  // Candidates: not self and not themselves a merged duplicate. A previously-
  // unmerged customer that used to have custId merged in is still a valid
  // primary, so we don't filter that out.
  const candidates = CUSTOMERS.filter(x => x.id !== custId && !x.mergedInto);
  if (!candidates.length) {
    showModal('Merge customer into…', '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:18px 0">No primary candidates available.</div>', null, null);
    return;
  }
  const card = c => `
    <div onmousedown="closeModal();mergeCustomers('${escAttr(custId)}','${escAttr(c.id)}')" style="padding:10px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;display:flex;gap:10px;align-items:center;background:var(--off2);margin-bottom:6px;transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
      <div style="width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;flex-shrink:0">${escHtml((c.first[0]||'') + (c.last[0]||''))}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--ink)">${escHtml(c.first + ' ' + c.last)}</div>
        <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${escHtml(c.id)} · ${escHtml(c.email || '')}</div>
      </div>
      <span class="vip-badge vip-${(c.vip || '').toLowerCase()}">${escHtml(c.vip || '')}</span>
    </div>`;
  showModal('Merge customer into…', `
    <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">${escHtml(src.first + ' ' + src.last)} (${escHtml(src.id)}) will be marked as a duplicate of the primary you choose. All of this customer's tickets reassign to the primary, internal notes copy over, and any blank profile fields on the primary fill in from this record.</div>
    <div style="max-height:380px;overflow-y:auto">${candidates.map(card).join('')}</div>
  `, null, null);
}

function mergeCustomers(srcId, primaryId) {
  if (srcId === primaryId) return;
  const src = CUSTOMERS.find(x => x.id === srcId);
  const primary = CUSTOMERS.find(x => x.id === primaryId);
  if (!src || !primary || src.mergedInto) return;
  if (primary.mergedInto) {
    alert(`${primaryId} is already a duplicate of ${primary.mergedInto}. Pick the chain's primary instead.`);
    return;
  }
  // Reassign tickets, stamping each with the original customerId so un-merge
  // can put them back on the source if the merge is reversed.
  TICKETS.forEach(t => {
    if (t.customerId === srcId) {
      t.preMergeCustomerId = srcId;
      t.customerId = primaryId;
      logTicketEvent(t.id, 'system', `Customer merged: ${srcId} → ${primaryId}`);
    }
  });
  // Merge notes: append src.notes onto primary.notes with a separator marker
  // so an admin can see the boundary.
  if (src.notes && src.notes.length) {
    if (!primary.notes) primary.notes = [];
    primary.notes.push({ author:'System', ts: new Date().toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }), text: `── Notes merged from ${srcId} ──`, mergedFromCustomerId: srcId });
    src.notes.forEach(n => primary.notes.push({ ...n, mergedFromCustomerId: srcId }));
  }
  // Backfill primary fields from src where primary is blank, recording which
  // fields we touched so unmergeCustomer can put the primary back the way it
  // was instead of leaving it carrying the source's data forever.
  primary._mergeBackfilled = primary._mergeBackfilled || {};
  primary._mergeBackfilled[srcId] = { fields: [], custom: [] };
  ['email','mobile','username','brand','vip','jurisdiction','kyc','since','bo'].forEach(f => {
    if (!primary[f] && src[f]) {
      primary[f] = src[f];
      primary._mergeBackfilled[srcId].fields.push(f);
    }
  });
  if (src.custom) {
    primary.custom = primary.custom || {};
    Object.keys(src.custom).forEach(k => {
      if (primary.custom[k] === undefined || primary.custom[k] === '') {
        primary.custom[k] = src.custom[k];
        primary._mergeBackfilled[srcId].custom.push(k);
      }
    });
  }
  src.mergedInto = primaryId;
  src.mergedAt = new Date().toISOString().slice(0, 10);
  primary.mergedFrom = primary.mergedFrom || [];
  if (!primary.mergedFrom.includes(srcId)) primary.mergedFrom.push(srcId);
  // Navigate to the primary so the agent sees the consolidated view.
  CUSTOMER_SELECTED = primaryId;
  renderPage('customers');
}

function unmergeCustomer(srcId) {
  const src = CUSTOMERS.find(x => x.id === srcId);
  if (!src || !src.mergedInto) return;
  const primaryId = src.mergedInto;
  const primary = CUSTOMERS.find(x => x.id === primaryId);
  // Walk tickets and put them back on the source.
  TICKETS.forEach(t => {
    if (t.preMergeCustomerId === srcId && t.customerId === primaryId) {
      t.customerId = srcId;
      delete t.preMergeCustomerId;
      logTicketEvent(t.id, 'system', `Customer un-merged: restored to ${srcId}`);
    }
  });
  // Strip notes that came from src, including the separator marker.
  if (primary && primary.notes) {
    primary.notes = primary.notes.filter(n => n.mergedFromCustomerId !== srcId);
  }
  // Roll back fields the merge backfilled from this source, so the primary
  // returns to the state it was in pre-merge for those fields.
  if (primary && primary._mergeBackfilled?.[srcId]) {
    const back = primary._mergeBackfilled[srcId];
    (back.fields || []).forEach(f => { primary[f] = ''; });
    if (primary.custom && back.custom) (back.custom || []).forEach(k => { delete primary.custom[k]; });
    delete primary._mergeBackfilled[srcId];
  }
  if (primary && primary.mergedFrom) primary.mergedFrom = primary.mergedFrom.filter(x => x !== srcId);
  delete src.mergedInto;
  delete src.mergedAt;
  CUSTOMER_SELECTED = srcId;
  renderPage('customers');
}

function updateCustomField(custId, fieldId, value) {
  const c = CUSTOMERS.find(x => x.id === custId);
  if (!c) return;
  if (!c.custom) c.custom = {};
  c.custom[fieldId] = value;
}

function showCustomerGDPR(custId) {
  showModal('GDPR actions', `
    <div class="gdpr-action"><div class="gdpr-action-title">Request erasure</div><div class="gdpr-action-desc">Permanently delete this customer's personal data under Article 17.</div><button class="btn btn-sm btn-danger" onclick="closeModal()">Request erasure</button></div>
    <div class="gdpr-action"><div class="gdpr-action-title">Redact in-thread data</div><div class="gdpr-action-desc">Mask PII in this customer's ticket messages.</div><button class="btn btn-sm" onclick="closeModal()">Redact</button></div>
    <div class="gdpr-action"><div class="gdpr-action-title">SAR export</div><div class="gdpr-action-desc">Export all data held about this customer.</div><button class="btn btn-sm" onclick="closeModal()">Export</button></div>
  `, null, null);
}

function renderCustomerDetail(custId) {
  const c = CUSTOMERS.find(x => x.id === custId);
  if (!c) { CUSTOMER_SELECTED = null; return renderCustomers(); }
  const s = getCustomerStats(custId);
  const admin = isAdmin();
  const activity = getCustomerActivity(custId);
  const tagsList = getCustomerCommonTags(custId);
  const risks = getCustomerRisk(c);
  const notes = c.notes || [];

  const ticketRows = s.tickets.map(t => `
    <tr onclick="openTicket('${escAttr(t.id)}')" style="cursor:pointer">
      <td class="bold">${t.id}</td>
      <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--ink)">${t.subject}</td>
      <td><span class="tag tag-${t.status}">${t.status}</span></td>
      <td><span class="tag tag-${t.priority}">${t.priority}</span></td>
      <td>${t.agent}</td>
      <td><span class="sla-${t.sla}" style="font-size:11px;text-transform:uppercase;font-weight:500">${t.sla}</span></td>
      <td style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${t.updated}</td>
    </tr>`).join('');

  const customFields = CUSTOM_FIELDS.map(cf => {
    const val = c.custom?.[cf.id] ?? '';
    const inputType = cf.type === 'number' ? 'number' : cf.type === 'date' ? 'date' : 'text';
    return `
      <div class="form-row">
        <label class="form-label">${cf.label}</label>
        ${admin
          ? `<input class="form-input" type="${inputType}" value="${String(val).replace(/"/g,'&quot;')}" oninput="updateCustomField('${escAttr(c.id)}','${cf.id}',this.value)"/>`
          : `<div style="font-size:13px;color:var(--ink);padding:9px 12px;background:var(--off2);border:1px solid var(--rule);border-radius:var(--r);min-height:36px;display:flex;align-items:center">${val || '<span style="color:var(--ink3)">—</span>'}</div>`}
      </div>`;
  }).join('') || '<div style="color:var(--ink3);font-size:12px;padding:8px 0">No custom fields defined. Admins can add them via Manage Fields on the list view.</div>';

  const riskPanel = risks.length ? `
    <div class="card" style="margin-bottom:16px;border-color:rgba(248,113,113,0.3);background:rgba(248,113,113,0.04)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1l6 11H1L7 1z" stroke="var(--red)" stroke-width="1.4" stroke-linejoin="round"/><path d="M7 5v3M7 10v.5" stroke="var(--red)" stroke-width="1.4" stroke-linecap="round"/></svg>
        <div class="card-title" style="margin:0;color:var(--red)">Risk indicators</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${risks.map(r => `<span class="tag" style="font-size:10px;border-color:${r.level==='high'?'rgba(248,113,113,0.5)':'rgba(251,191,36,0.5)'};color:${r.level==='high'?'var(--red)':'var(--amber)'};background:${r.level==='high'?'var(--red-lt)':'var(--amber-lt)'}">${r.text}</span>`).join('')}
      </div>
    </div>` : '';

  const tagsBlock = tagsList.length ? `
    <div class="card" style="margin-bottom:16px">
      <div class="card-title">Common topics</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${tagsList.map(([tag, count]) => `<span class="tag tag-neutral" style="font-size:11px;display:inline-flex;align-items:center;gap:5px">${tag} <span style="color:var(--ink3);font-family:'DM Mono',monospace">${count}</span></span>`).join('')}
      </div>
    </div>` : '';

  const timelineBlock = activity.length ? `
    <div class="card">
      <div class="card-title">Activity timeline</div>
      <div class="cust-timeline">
        ${activity.map(a => `
          <div class="cust-timeline-item role-${a.role}" onclick="openTicket('${escAttr(a.ticketId)}')">
            <div style="display:flex;gap:8px;align-items:baseline;margin-bottom:3px">
              <span style="font-size:11px;font-weight:600;color:var(--ink)">${a.from}</span>
              ${a.role === 'note' ? '<span class="note-mark">Note</span>' : a.role === 'ai' ? '<span class="ai-mark">AI</span>' : ''}
              <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${a.ticketId}</span>
              <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink4);margin-left:auto">${a.ts}</span>
            </div>
            <div style="font-size:12px;color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${a.text}</div>
          </div>
        `).join('')}
      </div>
    </div>` : `<div class="card"><div class="card-title">Activity timeline</div><div style="color:var(--ink3);font-size:12px;text-align:center;padding:18px 0">No activity yet</div></div>`;

  const notesBlock = `
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="card-title" style="margin:0">Internal notes</div>
        <button class="btn btn-sm" onclick="addCustomerNote('${escAttr(c.id)}')">+ Add note</button>
      </div>
      ${notes.length ? notes.map((n, i) => `
        <div class="cust-note">
          <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:5px">
            <span style="font-size:11px;font-weight:600;color:var(--ink)">${n.author}</span>
            <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${n.ts}</span>
            ${admin ? `<button class="btn btn-sm btn-danger" style="margin-left:auto;padding:2px 8px;font-size:10px;border:none;background:transparent;color:var(--ink3)" onclick="deleteCustomerNote('${escAttr(c.id)}',${i})" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--ink3)'" title="Delete note">×</button>` : ''}
          </div>
          <div style="font-size:12.5px;color:var(--ink2);line-height:1.55;white-space:pre-wrap">${n.text}</div>
        </div>
      `).join('') : '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:18px 0">No notes yet — share context with the team by adding one.</div>'}
    </div>`;

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-breadcrumb">
          <span onclick="closeCustomerProfile()">Customers</span>
          <span class="tb-sep">/</span>
          <span style="color:var(--ink);font-weight:500">${c.first} ${c.last}</span>
        </div>
      </div>
      <div class="page-scroll">
        <div style="display:flex;gap:14px;align-items:center;padding:8px 0 18px;border-bottom:1px solid var(--rule);margin-bottom:18px">
          <div style="width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-weight:600;color:#fff;font-size:16px;flex-shrink:0">${(c.first||'').charAt(0)}${(c.last||'').charAt(0)}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:18px;font-weight:600;color:var(--ink)">${c.first} ${c.last}</div>
            <div style="font-size:12px;color:var(--ink3);margin-top:4px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
              <span style="font-family:'DM Mono',monospace">${c.id}</span>
              <span class="vip-badge vip-${c.vip.toLowerCase()}">${c.vip}</span>
              <span>${c.brand}</span>
              <span style="font-family:'DM Mono',monospace">${c.jurisdiction}</span>
            </div>
          </div>
          ${c.mergedInto ? `<span class="tag" style="flex-shrink:0;background:var(--purple-lt);color:var(--purple);border:1px solid var(--purple)">Merged → ${escHtml(c.mergedInto)}</span>` : `<span class="tag ${c.kyc==='Verified'?'tag-resolved':'tag-pending'}" style="flex-shrink:0">${c.kyc}</span>`}
        </div>
        ${c.mergedInto ? `<div style="margin:0 0 16px;padding:10px 14px;background:var(--purple-lt);border:1px solid var(--purple);border-radius:var(--r);font-size:11px;color:var(--purple);display:flex;align-items:center;gap:10px">
          <span style="font-weight:600;text-transform:uppercase;letter-spacing:.06em">Merged duplicate</span>
          <span style="color:var(--ink2)">→</span>
          <span class="link" onclick="CUSTOMER_SELECTED='${escAttr(c.mergedInto)}';renderPage('customers')" style="color:var(--purple);font-weight:500">${escHtml(c.mergedInto)}</span>
          <span style="color:var(--ink3);font-family:'DM Mono',monospace;font-size:10px">on ${escHtml(c.mergedAt || '—')}</span>
          ${admin ? `<button class="btn btn-sm" style="margin-left:auto" onclick="unmergeCustomer('${escAttr(c.id)}')">Un-merge</button>` : ''}
        </div>` : ''}
        ${(c.mergedFrom || []).length ? `<div class="card" style="margin-bottom:16px">
          <div class="card-title">Merged duplicates (${c.mergedFrom.length})</div>
          ${c.mergedFrom.map(mid => {
            const m = CUSTOMERS.find(x => x.id === mid);
            if (!m) return '';
            return `<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--rule);cursor:pointer" onclick="CUSTOMER_SELECTED='${escAttr(mid)}';renderPage('customers')">
              <div style="width:24px;height:24px;border-radius:50%;background:var(--ink);color:var(--w);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600">${escHtml((m.first[0]||'') + (m.last[0]||''))}</div>
              <div style="flex:1;min-width:0">
                <div style="font-size:12px;color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(m.first + ' ' + m.last)}</div>
                <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${escHtml(mid)} · merged ${escHtml(m.mergedAt || '—')}</div>
              </div>
            </div>`;
          }).join('')}
        </div>` : ''}
        <div class="cust-quickactions">
          <a href="mailto:${c.email}" class="btn btn-sm">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1" y="2.5" width="10" height="7" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M1.5 3l4.5 3.5L10.5 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Email
          </a>
          <a href="tel:${c.mobile.replace(/\s/g,'')}" class="btn btn-sm">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 1.5h2l1 2.5L3.5 5a8 8 0 0 0 3.5 3.5L8.5 7l2.5 1V11a1 1 0 0 1-1 1A9 9 0 0 1 1 2.5a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
            Call
          </a>
          <button class="btn btn-sm" onclick="addCustomerNote('${escAttr(c.id)}')">+ Note</button>
          ${c.bo ? `<a href="${c.bo}" target="_blank" rel="noopener" class="btn btn-sm">Backoffice ↗</a>` : ''}
          ${admin && !c.mergedInto ? `<button class="btn btn-sm" onclick="showMergeCustomerModal('${escAttr(c.id)}')">↩ Merge</button>` : ''}
          <button class="btn btn-sm btn-danger" style="margin-left:auto" onclick="showCustomerGDPR('${escAttr(c.id)}')">GDPR</button>
        </div>
        ${riskPanel}
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px">
          <div class="r-tile" style="border-color:rgba(34,211,238,0.3);background:var(--cyan-lt)"><div class="r-tile-n" style="color:var(--cyan)">${s.open}</div><div class="r-tile-l" style="color:var(--cyan)">Open</div></div>
          <div class="r-tile"><div class="r-tile-n" style="color:var(--ink)">${s.total}</div><div class="r-tile-l" style="color:var(--ink3)">Total tickets</div></div>
          <div class="r-tile" style="border-color:rgba(251,191,36,0.3);background:var(--amber-lt)"><div class="r-tile-n" style="color:var(--amber)">${s.csatCount?s.avgCSAT.toFixed(1):'—'}</div><div class="r-tile-l" style="color:var(--amber)">CSAT (${s.csatCount})</div></div>
          <div class="r-tile" style="border-color:${c.consent?'rgba(52,211,153,0.3)':'rgba(248,113,113,0.3)'};background:${c.consent?'var(--green-lt)':'var(--red-lt)'}"><div class="r-tile-n" style="color:${c.consent?'var(--green)':'var(--red)'};font-size:18px;line-height:1.2">${c.consent?'Yes':'No'}</div><div class="r-tile-l" style="color:${c.consent?'var(--green)':'var(--red)'}">Consent</div></div>
        </div>
        ${tagsBlock}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
          <div class="card">
            <div class="card-title">Profile</div>
            ${isFieldVisible('customer','email')        ? `<div class="ts-row"><span class="ts-key">Email</span><span class="ts-val">${escHtml(c.email)}</span></div>` : ''}
            ${isFieldVisible('customer','mobile')       ? `<div class="ts-row"><span class="ts-key">Mobile</span><span class="ts-val">${escHtml(c.mobile)}</span></div>` : ''}
            ${isFieldVisible('customer','username')     ? `<div class="ts-row"><span class="ts-key">Username</span><span class="ts-val" style="font-family:'DM Mono',monospace;font-size:12px">${escHtml(c.username)}</span></div>` : ''}
            ${isFieldVisible('customer','brand')        ? `<div class="ts-row"><span class="ts-key">Brand</span><span class="ts-val">${escHtml(c.brand)}</span></div>` : ''}
            ${isFieldVisible('customer','vip')          ? `<div class="ts-row"><span class="ts-key">VIP tier</span><span class="vip-badge vip-${(c.vip||'').toLowerCase()}">${escHtml(c.vip)}</span></div>` : ''}
            ${isFieldVisible('customer','jurisdiction') ? `<div class="ts-row"><span class="ts-key">Jurisdiction</span><span class="ts-val">${escHtml(c.jurisdiction)}</span></div>` : ''}
            ${isFieldVisible('customer','kyc')          ? `<div class="ts-row"><span class="ts-key">KYC</span><span class="ts-val">${escHtml(c.kyc)}</span></div>` : ''}
            ${isFieldVisible('customer','since')        ? `<div class="ts-row"><span class="ts-key">Customer since</span><span class="ts-val">${escHtml(c.since)}</span></div>` : ''}
          </div>
          <div class="card">
            <div class="card-title">Custom fields</div>
            ${customFields}
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
          ${timelineBlock}
          ${notesBlock}
        </div>
        <div class="card">
          <div class="card-title">Tickets</div>
          ${s.tickets.length ? `
            <table class="tbl">
              <thead><tr><th>ID</th><th>Subject</th><th>Status</th><th>Priority</th><th>Agent</th><th>SLA</th><th>Updated</th></tr></thead>
              <tbody>${ticketRows}</tbody>
            </table>
          ` : `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No tickets</div><div class="empty-line"></div></div>`}
        </div>
      </div>
    </div>`;
}


// ─── Modal helpers ─────────────────────────────────────────────────────────────
function showModal(title, body, onConfirm, confirmLabel='Save', isLarge=false) {
  document.getElementById('modal-container').innerHTML = `
    <div class="modal-bg" onclick="closeModal()">
      <div class="${isLarge?'modal modal-lg':'modal'}" onclick="event.stopPropagation()">
        <div class="modal-head">
          <div class="modal-title">${title}</div>
          <div class="modal-close" onclick="closeModal()">×</div>
        </div>
        <div class="modal-body">${body}</div>
        ${onConfirm?`<div class="modal-foot">
          <button class="btn" onclick="closeModal()">Cancel</button>
          <button class="btn btn-solid" onclick="(${onConfirm.toString()})()">${confirmLabel}</button>
        </div>`:''}
      </div>
    </div>`;
}
function closeModal() { document.getElementById('modal-container').innerHTML=''; }

// ─── Global search ───────────────────────────────────────────────────────────
const SEARCH_PAGES = [
  {p:'dashboard', l:'Dashboard'},
  {p:'tickets',   l:'Tickets'},
  {p:'inbox',     l:'Inbox'},
  {p:'customers', l:'Customers'},
  {p:'reports',   l:'Reports'},
  {p:'agents',    l:'Agents'},
  {p:'ai',        l:'AI Intelligence'},
  {p:'kb',        l:'Knowledge Base'},
  {p:'workflows', l:'Workflows'},
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
      return `<div class="gs-result" onmousedown="gsGo('ticket','${escAttr(t.id)}')"><span class="gs-result-type">${t.id}</span><span class="gs-result-main">${t.subject}</span><span class="gs-result-meta">${meta}</span></div>`;
    }).join('');
  }
  if (customers.length) {
    html += '<div class="gs-group">Customers</div>';
    html += customers.map(c => `<div class="gs-result" onmousedown="gsGo('customer','${escAttr(c.id)}')"><span class="gs-result-type">${c.id}</span><span class="gs-result-main">${c.first} ${c.last}</span><span class="gs-result-meta">${c.email}</span></div>`).join('');
  }
  if (agents.length) {
    html += '<div class="gs-group">Agents</div>';
    html += agents.map(a => `<div class="gs-result" onmousedown="gsGo('agent','${escAttr(a.name)}')"><span class="gs-result-type">${a.role}</span><span class="gs-result-main">${a.name}</span><span class="gs-result-meta">${a.active?'Active':'Deactivated'}</span></div>`).join('');
  }
  if (articles.length) {
    html += '<div class="gs-group">Knowledge Base</div>';
    html += articles.map(a => `<div class="gs-result" onmousedown="gsGo('article','${escAttr(a.id)}')"><span class="gs-result-type">${a.id}</span><span class="gs-result-main">${a.title}</span><span class="gs-result-meta">${a.category}</span></div>`).join('');
  }
  if (pages.length) {
    html += '<div class="gs-group">Pages</div>';
    html += pages.map(pg => `<div class="gs-result" onmousedown="gsGo('page','${pg.p}')"><span class="gs-result-type">Page</span><span class="gs-result-main">${pg.l}</span><span class="gs-result-meta"></span></div>`).join('');
  }
  if (!html) html = `<div class="gs-empty">No matches for "<strong style="color:var(--ink2)">${escHtml(q)}</strong>"</div>`;
  else html += `<div style="padding:9px 14px;border-top:1px solid var(--rule);text-align:center;background:var(--off2);position:sticky;bottom:0"><span class="link" onmousedown="gsOpenAllResults(${JSON.stringify(q)})" style="font-size:11px;font-weight:500">See all results for "${escHtml(q)}" →</span></div>`;

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
    KB_SELECTED = id;
    document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
    let target = null;
    document.querySelectorAll('.sb-item').forEach(i => {
      if ((i.getAttribute('onclick') || '').includes("'kb'")) target = i;
    });
    if (target) target.classList.add('active');
    renderPage('kb');
  }
  else if (type === 'agent') {
    const a = AGENTS.find(x => x.name === id);
    if (!a) return;
    ROLES_VIEW_AGENTS = a.role;
    document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
    const rolesItem = document.getElementById('nav-roles');
    if (rolesItem) rolesItem.classList.add('active');
    renderPage('roles');
  }
  else if (type === 'page') {
    let target = null;
    document.querySelectorAll('.sb-item').forEach(i => {
      const a = i.getAttribute('onclick') || '';
      if (a.includes(`'${id}'`)) target = i;
    });
    nav(id, target);
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
    if (idx >= 0) items[idx].dispatchEvent(new MouseEvent('mousedown'));
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

// ─── Full search results page ────────────────────────────────────────────────
let SEARCH_PAGE_QUERY = '';

function renderSearchResults() {
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
        return `<div onclick="openTicket('${escAttr(t.id)}')" style="padding:9px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;display:flex;gap:10px;align-items:center;background:var(--off2);transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
          <span class="tag tag-${t.status}" style="font-size:9px">${t.status}</span>
          <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);flex-shrink:0">${t.id}</span>
          <span style="flex:1;font-size:12.5px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(t.subject)}</span>
          <span style="font-size:11px;color:var(--ink3);flex-shrink:0">${cust ? escHtml(cust.first + ' ' + cust.last) : '—'}</span>
        </div>`;
      }).join('')}
    </div>`);

  const customersHtml = sectionHtml('Customers', customers, `
    <div style="display:flex;flex-direction:column;gap:5px">
      ${customers.slice(0, 50).map(c => `<div onclick="CUSTOMER_SELECTED='${escAttr(c.id)}';navTo('customers')" style="padding:9px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;display:flex;gap:10px;align-items:center;background:var(--off2);transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
        <div style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:#fff;flex-shrink:0">${(c.first||'').charAt(0)}${(c.last||'').charAt(0)}</div>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);flex-shrink:0">${c.id}</span>
        <span style="flex:1;font-size:12.5px;color:var(--ink);font-weight:500">${escHtml(c.first + ' ' + c.last)}</span>
        <span class="vip-badge vip-${c.vip.toLowerCase()}" style="flex-shrink:0">${c.vip}</span>
        <span style="font-size:11px;color:var(--ink3);flex-shrink:0">${escHtml(c.email)}</span>
      </div>`).join('')}
    </div>`);

  const agentsHtml = sectionHtml('Agents', agents, `
    <div style="display:flex;flex-direction:column;gap:5px">
      ${agents.slice(0, 50).map(a => `<div onclick="AGENT_SELECTED='${escAttr(a.name)}';navTo('agents')" style="padding:9px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;display:flex;gap:10px;align-items:center;background:var(--off2);transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
        <div style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:#fff;flex-shrink:0">${a.initials}</div>
        <span style="flex:1;font-size:12.5px;color:var(--ink);font-weight:500">${escHtml(a.name)}</span>
        <span class="tag tag-neutral" style="font-size:10px">${escHtml(a.role)}</span>
        <span class="tag ${a.active?'tag-resolved':'tag-gdpr'}" style="font-size:10px">${a.active?'Active':'Off'}</span>
      </div>`).join('')}
    </div>`);

  const articlesHtml = sectionHtml('Knowledge Base', articles, `
    <div style="display:flex;flex-direction:column;gap:5px">
      ${articles.slice(0, 50).map(a => `<div onclick="KB_SELECTED='${escAttr(a.id)}';navTo('kb')" style="padding:9px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;display:flex;gap:10px;align-items:center;background:var(--off2);transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);flex-shrink:0">${a.id}</span>
        <span style="flex:1;font-size:12.5px;color:var(--ink);font-weight:500">${escHtml(a.title)}</span>
        <span class="tag tag-neutral" style="font-size:10px">${escHtml(a.category)}</span>
      </div>`).join('')}
    </div>`);

  const tagsHtml = sectionHtml('Tags', tags, `
    <div style="display:flex;flex-wrap:wrap;gap:6px">
      ${tags.slice(0, 50).map(t => `<span onclick="TAG_SELECTED='${escAttr(t.tag)}';navTo('tags')" class="tag tag-neutral" style="font-size:11px;cursor:pointer;display:inline-flex;align-items:center;gap:5px">${escHtml(t.tag)}<span style="color:var(--ink3);font-family:'DM Mono',monospace">${t.count}</span></span>`).join('')}
    </div>`);

  const pagesHtml = sectionHtml('Pages', pages, `
    <div style="display:flex;flex-direction:column;gap:5px">
      ${pages.map(pg => `<div onclick="navTo('${escAttr(pg.p)}')" style="padding:9px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;display:flex;gap:10px;align-items:center;background:var(--off2);transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
        <span class="tag tag-neutral" style="font-size:10px">Page</span>
        <span style="flex:1;font-size:12.5px;color:var(--ink);font-weight:500">${escHtml(pg.l)}</span>
      </div>`).join('')}
    </div>`);

  const body = ql
    ? (totalCount === 0
        ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No matches for "${escHtml(SEARCH_PAGE_QUERY)}"</div><div class="empty-line"></div></div>`
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
        <input class="filter-select" id="search-page-input" placeholder="Search across the workspace…" style="flex:1;max-width:520px" value="${escHtml(SEARCH_PAGE_QUERY)}" oninput="searchPageSetQuery(this.value)" autofocus/>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3)">${ql ? `${totalCount} result${totalCount===1?'':'s'}` : ''}</span>
      </div>
      ${ql ? `<div class="filter-bar" style="border-top:none;padding-top:6px;padding-bottom:10px">
        <span class="filter-label">View</span>
        ${filters.map(f => `<span class="filter-tag" style="cursor:pointer;${SEARCH_PAGE_FILTER===f.k?'border-color:var(--purple);color:var(--purple);background:var(--purple-lt)':''}" onclick="SEARCH_PAGE_FILTER='${f.k}';renderPage('search')">${f.l}</span>`).join('')}
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

document.addEventListener('mousedown', e => {
  const wrap = document.querySelector('.gs-wrap');
  const results = document.getElementById('gs-results');
  if (wrap && results && !wrap.contains(e.target)) results.classList.remove('show');
  const notifWrap = document.querySelector('.notif-wrap');
  const notifDD = document.getElementById('notif-dropdown');
  if (notifWrap && notifDD && !notifWrap.contains(e.target)) notifDD.classList.remove('show');
  const profileWrap = document.querySelector('.profile-wrap');
  const profileDD = document.getElementById('profile-dropdown');
  if (profileWrap && profileDD && !profileWrap.contains(e.target)) {
    profileDD.classList.remove('show');
    document.getElementById('profile-btn')?.classList.remove('active');
  }
  document.querySelectorAll('.comp-menu').forEach(menu => {
    if (menu.style.display === 'block' && !menu.parentElement.contains(e.target)) {
      menu.style.display = 'none';
    }
  });
});

function toggleProfileMenu() {
  const dd = document.getElementById('profile-dropdown');
  const btn = document.getElementById('profile-btn');
  if (!dd) return;
  if (dd.classList.contains('show')) { dd.classList.remove('show'); btn?.classList.remove('active'); }
  else { dd.classList.add('show'); btn?.classList.add('active'); }
}

function profileMenuGo(action) {
  document.getElementById('profile-dropdown')?.classList.remove('show');
  document.getElementById('profile-btn')?.classList.remove('active');
  if (action === 'profile')        { navTo('profile'); }
  else if (action === 'settings')  { navTo('settings'); }
  else if (action === 'help')      { navTo('help'); }
  else if (action === 'translator'){ showTranslatorModal(''); }
  else if (action === 'signout')   { logout(); }
}

// ─── Notifications ───────────────────────────────────────────────────────────
const NOTIFICATIONS_READ = new Set();
const NOTIFICATIONS_DISMISSED = new Set();
let NOTIF_PAGE_FILTER_TYPE = 'all';
let NOTIF_PAGE_FILTER_READ = 'all';

function getNotifications() {
  const out = [];
  const wakeWindowMs = 24 * 60 * 60 * 1000;
  // Mentions of the current session user across all tickets — emit before per-ticket
  // status notifications so they're not crowded out when an SLA breach also exists.
  if (SESSION?.name && NOTIF_PREFS.mention !== false) {
    for (const t of TICKETS) {
      (t.msgs || []).forEach((m, i) => {
        if (m.r !== 'note' || !m.mentions || !m.mentions.includes(SESSION.name)) return;
        if (m.from === SESSION.name) return;
        const mid = `mention-${t.id}-${i}`;
        if (NOTIFICATIONS_DISMISSED.has(mid)) return;
        out.push({id:mid, type:'mention', color:'var(--purple)', title:`Mentioned by ${m.from}`, body:`${t.id} — ${t.subject}`, ticketId:t.id, ts:m.ts});
      });
    }
  }
  for (const t of TICKETS) {
    let n = null;
    // Snooze wake-up takes priority for ~24h after firing so an agent doesn't miss it.
    if (t.snoozeWokenAt && NOTIF_PREFS.wake !== false && (Date.now() - new Date(t.snoozeWokenAt).getTime()) < wakeWindowMs) {
      n = {id:'wake-'+t.id, type:'wake', color:'var(--blue)', title:'Snooze elapsed', body:`${t.id} — ${t.subject}`, ticketId:t.id, ts:t.updated};
    } else if (t.sla === 'breach' && NOTIF_PREFS.breach) {
      n = {id:'breach-'+t.id, type:'breach', color:'var(--red)', title:'SLA breach', body:`${t.id} — ${t.subject}`, ticketId:t.id, ts:t.updated};
    } else if (t.status === 'escalated' && NOTIF_PREFS.escalated) {
      n = {id:'esc-'+t.id, type:'escalated', color:'var(--purple)', title:'Escalated', body:`${t.id} — ${t.subject}`, ticketId:t.id, ts:t.updated};
    } else if (t.status === 'gdpr' && NOTIF_PREFS.gdpr) {
      n = {id:'gdpr-'+t.id, type:'gdpr', color:'var(--red)', title:'GDPR request', body:`${t.id} — ${t.subject}`, ticketId:t.id, ts:t.updated};
    } else if (t.sla === 'warn' && NOTIF_PREFS.warn) {
      n = {id:'warn-'+t.id, type:'warn', color:'var(--amber)', title:'SLA warning', body:`${t.id} — ${t.subject}`, ticketId:t.id, ts:t.updated};
    }
    if (n && !NOTIFICATIONS_DISMISSED.has(n.id)) out.push(n);
  }
  return out;
}

function refreshNotifBadge() {
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  const n = getNotifications().filter(x => !NOTIFICATIONS_READ.has(x.id)).length;
  badge.textContent = n > 9 ? '9+' : String(n);
  badge.style.display = n > 0 ? 'flex' : 'none';
}

function renderNotifications() {
  const dd = document.getElementById('notif-dropdown');
  if (!dd) return;
  const items = getNotifications();
  const unread = items.filter(n => !NOTIFICATIONS_READ.has(n.id));
  let html = `
    <div class="notif-head">
      <div class="notif-title">Notifications ${items.length ? `<span class="notif-count">${unread.length} unread · ${items.length} total</span>` : ''}</div>
      ${unread.length ? `<div class="notif-mark" onmousedown="markAllNotifRead()">Mark all read</div>` : ''}
    </div>`;
  if (!items.length) {
    html += `<div class="notif-empty">All caught up — no notifications.</div>`;
  } else {
    html += items.map(n => `
      <div class="notif-item ${NOTIFICATIONS_READ.has(n.id)?'read':''}" onmousedown="openNotification('${n.id}','${n.ticketId}')">
        <div class="notif-dot" style="background:${n.color}"></div>
        <div class="notif-body">
          <div class="notif-row"><div class="notif-name">${n.title}</div><div class="notif-time">${n.ts}</div></div>
          <div class="notif-text">${n.body}</div>
        </div>
      </div>`).join('');
    html += `<div style="padding:10px 14px;border-top:1px solid var(--rule);text-align:center;background:var(--off2);position:sticky;bottom:0"><span class="link" onmousedown="closeNotifAndGo()" style="font-size:11px;font-weight:500">View all notifications →</span></div>`;
  }
  dd.innerHTML = html;
}

function closeNotifAndGo() {
  document.getElementById('notif-dropdown')?.classList.remove('show');
  document.getElementById('notif-btn')?.classList.remove('active');
  navTo('notifications');
}

function toggleNotifications() {
  const dd = document.getElementById('notif-dropdown');
  const btn = document.getElementById('notif-btn');
  if (!dd) return;
  if (dd.classList.contains('show')) {
    dd.classList.remove('show');
    btn?.classList.remove('active');
    return;
  }
  renderNotifications();
  dd.classList.add('show');
  btn?.classList.add('active');
}

function openNotification(notifId, ticketId) {
  NOTIFICATIONS_READ.add(notifId);
  const dd = document.getElementById('notif-dropdown');
  dd?.classList.remove('show');
  document.getElementById('notif-btn')?.classList.remove('active');
  refreshNotifBadge();
  if (ticketId) openTicket(ticketId);
}

function markAllNotifRead() {
  getNotifications().forEach(n => NOTIFICATIONS_READ.add(n.id));
  refreshNotifBadge();
  renderNotifications();
}

function notifPageSetType(v) { NOTIF_PAGE_FILTER_TYPE = v; renderPage('notifications'); }
function notifPageSetRead(v) { NOTIF_PAGE_FILTER_READ = v; renderPage('notifications'); }

function markNotifRead(id) {
  NOTIFICATIONS_READ.add(id);
  refreshNotifBadge();
  renderPage('notifications');
}

function dismissNotif(id) {
  NOTIFICATIONS_DISMISSED.add(id);
  refreshNotifBadge();
  renderPage('notifications');
}

function clearAllNotifications() {
  showModal('Clear notifications', '<div style="font-size:13px;color:var(--ink2);line-height:1.6">Dismiss all current notifications? They will be removed from the bell and the notifications page.</div>', () => {
    getNotifications().forEach(n => NOTIFICATIONS_DISMISSED.add(n.id));
    refreshNotifBadge();
    closeModal(); renderPage('notifications');
  }, 'Clear all');
}

function openNotificationFromPage(id, ticketId) {
  NOTIFICATIONS_READ.add(id);
  refreshNotifBadge();
  if (ticketId) openTicket(ticketId);
}

function markAllNotifReadAndRender() {
  markAllNotifRead();
  renderPage('notifications');
}

function renderNotificationsPage() {
  const all = getNotifications();
  let list = [...all];
  if (NOTIF_PAGE_FILTER_TYPE !== 'all') list = list.filter(n => n.type === NOTIF_PAGE_FILTER_TYPE);
  if (NOTIF_PAGE_FILTER_READ === 'unread') list = list.filter(n => !NOTIFICATIONS_READ.has(n.id));
  if (NOTIF_PAGE_FILTER_READ === 'read')   list = list.filter(n =>  NOTIFICATIONS_READ.has(n.id));

  const total = all.length;
  const unread = all.filter(n => !NOTIFICATIONS_READ.has(n.id)).length;
  const read = total - unread;
  const types = { breach:0, escalated:0, gdpr:0, warn:0 };
  all.forEach(n => { if (types[n.type] !== undefined) types[n.type]++; });
  const highPri = types.breach + types.escalated + types.gdpr;

  const items = list.map(n => {
    const isRead = NOTIFICATIONS_READ.has(n.id);
    return `
      <div style="display:flex;gap:12px;padding:14px;border:1px solid var(--rule);border-radius:var(--r);background:${isRead?'var(--off2)':'var(--off)'};transition:all .15s;align-items:stretch">
        <div style="width:4px;border-radius:2px;background:${n.color};flex-shrink:0;align-self:stretch"></div>
        <div style="flex:1;min-width:0;cursor:pointer" onclick="openNotificationFromPage('${escAttr(n.id)}','${escAttr(n.ticketId)}')">
          <div style="display:flex;gap:10px;align-items:center;margin-bottom:4px">
            <span style="font-size:13px;font-weight:600;color:var(--ink)">${n.title}</span>
            ${!isRead ? '<span style="width:6px;height:6px;border-radius:50%;background:var(--purple);box-shadow:0 0 6px var(--purple);flex-shrink:0"></span>' : ''}
            <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${n.ts}</span>
          </div>
          <div style="font-size:12.5px;color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${n.body}</div>
        </div>
        <div style="display:flex;gap:4px;align-items:center;flex-shrink:0" onclick="event.stopPropagation()">
          ${!isRead ? `<button class="btn btn-sm" onclick="markNotifRead('${escAttr(n.id)}')" title="Mark read">Mark read</button>` : ''}
          <button class="btn btn-sm btn-danger" onclick="dismissNotif('${escAttr(n.id)}')" title="Dismiss">Dismiss</button>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Notifications</div>
        ${unread ? `<button class="btn btn-sm" onclick="markAllNotifReadAndRender()">Mark all read</button>` : ''}
        ${total ? `<button class="btn btn-sm btn-danger" onclick="clearAllNotifications()">Clear all</button>` : ''}
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Total</div></div>
        <div class="kpi"><div class="kpi-n c-purple">${unread}</div><div class="kpi-l">Unread</div></div>
        <div class="kpi"><div class="kpi-n c-green">${read}</div><div class="kpi-l">Read</div></div>
        <div class="kpi"><div class="kpi-n c-red">${highPri}</div><div class="kpi-l">High priority</div></div>
      </div>
      <div class="filter-bar">
        <span class="filter-label">Filter</span>
        <select class="filter-select" onchange="notifPageSetType(this.value)">
          <option value="all"       ${NOTIF_PAGE_FILTER_TYPE==='all'?'selected':''}>All types</option>
          <option value="breach"    ${NOTIF_PAGE_FILTER_TYPE==='breach'?'selected':''}>SLA breach (${types.breach})</option>
          <option value="escalated" ${NOTIF_PAGE_FILTER_TYPE==='escalated'?'selected':''}>Escalated (${types.escalated})</option>
          <option value="gdpr"      ${NOTIF_PAGE_FILTER_TYPE==='gdpr'?'selected':''}>GDPR (${types.gdpr})</option>
          <option value="warn"      ${NOTIF_PAGE_FILTER_TYPE==='warn'?'selected':''}>SLA warning (${types.warn})</option>
        </select>
        <select class="filter-select" onchange="notifPageSetRead(this.value)">
          <option value="all"    ${NOTIF_PAGE_FILTER_READ==='all'?'selected':''}>All statuses</option>
          <option value="unread" ${NOTIF_PAGE_FILTER_READ==='unread'?'selected':''}>Unread only</option>
          <option value="read"   ${NOTIF_PAGE_FILTER_READ==='read'?'selected':''}>Read only</option>
        </select>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${total}</span>
      </div>
      <div class="page-scroll">
        ${list.length === 0
          ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">${total === 0 ? 'All caught up — no notifications' : 'No notifications match the filters'}</div><div class="empty-line"></div></div>`
          : `<div style="display:flex;flex-direction:column;gap:8px">${items}</div>
             <div style="font-size:11px;color:var(--ink3);text-align:center;margin-top:18px;line-height:1.6">Notifications are computed live from ticket state. Configure which types appear in <span class="link" onclick="navTo('settings');setSettingsTab('notifications')">Settings → Notifications</span>.</div>`}
      </div>
    </div>`;
}

// ─── Settings ────────────────────────────────────────────────────────────────
let NOTIF_PREFS = JSON.parse(localStorage.getItem('notif_prefs') || 'null') || { breach:true, escalated:true, gdpr:true, warn:true, wake:true, mention:true };
if (typeof NOTIF_PREFS.wake === 'undefined') NOTIF_PREFS.wake = true;
if (typeof NOTIF_PREFS.mention === 'undefined') NOTIF_PREFS.mention = true;

// ─── Third-party KB integration ─────────────────────────────────────────────
// Admins point this at their own KB service. The adapter is intentionally
// generic: configure a base URL + path template (with {query} placeholder),
// an optional auth header, and which JSON fields hold the title/body/URL.
// Composer's "AI Reply with KB" action and the ticket sidebar "External KB"
// block both consume the same fetchKbArticles() result.
const KB_INTEGRATION_DEFAULTS = {
  enabled: false,
  baseUrl: '',
  searchPath: '/articles?q={query}',
  apiKey: '',
  authHeader: 'Authorization',
  authPrefix: 'Bearer ',
  resultsField: '',   // dot-path into response, e.g. "data" or "data.items"; blank = root
  idField: 'id',
  titleField: 'title',
  bodyField: 'body',
  urlField: 'url',
  maxResults: 3,
};
let KB_INTEGRATION = Object.assign({}, KB_INTEGRATION_DEFAULTS, (() => {
  try { return JSON.parse(localStorage.getItem('kb_integration') || '{}') || {}; }
  catch (e) { return {}; }
})());

function saveKbIntegration() {
  try { localStorage.setItem('kb_integration', JSON.stringify(KB_INTEGRATION)); }
  catch (e) { console.warn('[kb] persist failed', e); }
}

function getByPath(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

async function fetchKbArticles(query) {
  const cfg = KB_INTEGRATION;
  if (!cfg.enabled || !cfg.baseUrl || !cfg.searchPath) return { articles: [], error: 'KB integration is disabled or unconfigured.' };
  if (!query || !query.trim()) return { articles: [], error: 'Empty query.' };
  const url = cfg.baseUrl.replace(/\/$/, '') + cfg.searchPath.replace(/\{query\}/g, encodeURIComponent(query.trim().slice(0, 300)));
  const headers = { 'Accept': 'application/json' };
  if (cfg.apiKey && cfg.authHeader) headers[cfg.authHeader] = (cfg.authPrefix || '') + cfg.apiKey;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return { articles: [], error: `KB request failed: HTTP ${res.status}` };
    const data = await res.json();
    let list = getByPath(data, cfg.resultsField);
    if (!Array.isArray(list)) list = Array.isArray(data) ? data : [];
    const max = Math.max(1, Math.min(20, parseInt(cfg.maxResults, 10) || 3));
    const articles = list.slice(0, max).map(item => ({
      id:    getByPath(item, cfg.idField)    ?? '',
      title: getByPath(item, cfg.titleField) ?? '(untitled)',
      body:  getByPath(item, cfg.bodyField)  ?? '',
      url:   getByPath(item, cfg.urlField)   ?? '',
    }));
    return { articles };
  } catch (e) {
    return { articles: [], error: 'KB fetch failed: ' + (e?.message || 'network error') };
  }
}

// LRU cache so a long session viewing many tickets can't grow memory without
// bound. Map.set on an existing key + delete-then-set on read are the standard
// JS LRU pattern (Map preserves insertion order). 50 entries is plenty for
// active triage and trivial in memory.
const KB_TICKET_CACHE = new Map();
const KB_CACHE_LIMIT  = 50;
function kbCacheSet(id, value) {
  if (KB_TICKET_CACHE.has(id)) KB_TICKET_CACHE.delete(id);
  KB_TICKET_CACHE.set(id, value);
  while (KB_TICKET_CACHE.size > KB_CACHE_LIMIT) {
    const oldest = KB_TICKET_CACHE.keys().next().value;
    KB_TICKET_CACHE.delete(oldest);
  }
}

// Long customer messages produce poor full-text search hits and waste tokens.
// Combine the ticket subject with the first sentence of the customer's first
// message, capped at 200 chars.
function buildKbQuery(t) {
  const firstCust = (t.msgs || []).find(m => m.r === 'customer');
  const sub = (t.subject || '').trim();
  let body = firstCust ? (firstCust.t || '').trim() : '';
  const stop = body.search(/[.\n!?]/);
  if (stop > 12) body = body.slice(0, stop);
  const q = (sub + ' ' + body).trim();
  return q.slice(0, 200);
}

async function refreshTicketKbSuggestions(ticketId) {
  const t = TICKETS.find(x => x.id === ticketId);
  if (!t || !KB_INTEGRATION.enabled) return;
  const query = buildKbQuery(t);
  if (!query) return;
  kbCacheSet(ticketId, { loading: true, articles: [], error: null });
  if (CURRENT_TICKET === ticketId) openTicket(ticketId);
  const result = await fetchKbArticles(query);
  kbCacheSet(ticketId, { loading: false, articles: result.articles, error: result.error || null });
  if (CURRENT_TICKET === ticketId) openTicket(ticketId);
}

// Module-scoped state for the Settings → Knowledge Base test panel. Kept off
// `window` so it doesn't pollute the global namespace.
let KB_TEST_STATE = null;

function renderSettings() {
  const tabs = [
    {k:'profile',       l:'Profile'},
    {k:'appearance',    l:'Appearance'},
    {k:'notifications', l:'Notifications'},
    {k:'ai',            l:'AI Assistant'},
    {k:'knowledge-base', l:'Knowledge Base'},
    {k:'language',      l:'Language'},
  ];
  const tabbar = tabs.map(t => `<div class="settings-tab ${SETTINGS_TAB===t.k?'active':''}" onclick="setSettingsTab('${t.k}')">${t.l}</div>`).join('');
  let panel = '';
  if      (SETTINGS_TAB === 'profile')       panel = settingsProfile();
  else if (SETTINGS_TAB === 'appearance')    panel = settingsAppearance();
  else if (SETTINGS_TAB === 'notifications') panel = settingsNotifications();
  else if (SETTINGS_TAB === 'ai')            panel = settingsAI();
  else if (SETTINGS_TAB === 'knowledge-base') panel = settingsKnowledgeBase();
  else if (SETTINGS_TAB === 'language')      panel = settingsLanguage();
  return `
    <div class="page">
      <div class="topbar"><div class="tb-title">Settings</div></div>
      <div class="page-scroll">
        <div class="settings-shell">
          <aside class="settings-side">${tabbar}</aside>
          <div class="settings-panel">${panel}</div>
        </div>
      </div>
    </div>`;
}

function setSettingsTab(k) { SETTINGS_TAB = k; renderPage('settings'); }

function settingsProfile() {
  return `
    <div class="settings-section">
      <div class="settings-h">Account</div>
      <div style="display:flex;gap:12px;align-items:center;padding:8px 0 18px;border-bottom:1px solid var(--rule);margin-bottom:18px">
        <div style="width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-weight:600;color:#fff;font-size:14px">${SESSION?.initials||'??'}</div>
        <div>
          <div style="font-size:15px;font-weight:600;color:var(--ink)">${SESSION?.name||'—'}</div>
          <div style="font-size:12px;color:var(--ink3)">${SESSION?.role||'—'}</div>
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">Display name</label>
        <input class="form-input" id="set-name" value="${SESSION?.name||''}" oninput="updateProfileName(this.value)"/>
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label class="form-label">Initials</label>
          <input class="form-input" id="set-initials" value="${SESSION?.initials||''}" maxlength="3" oninput="updateProfileInitials(this.value)"/>
        </div>
        <div class="form-row">
          <label class="form-label">Role</label>
          <input class="form-input" value="${SESSION?.role||''}" disabled style="opacity:.6"/>
        </div>
      </div>
      <div style="margin-top:16px"><button class="btn btn-danger" onclick="logout()">Sign out</button></div>
    </div>`;
}

function updateProfileName(name) {
  const trimmed = name.trim();
  if (!SESSION || !trimmed) return;
  SESSION.name = trimmed;
  const a = document.getElementById('sb-uname');   if (a) a.textContent = trimmed;
  const b = document.getElementById('sf-name');    if (b) b.textContent = trimmed;
  const c = document.getElementById('pf-name-sm'); if (c) c.textContent = trimmed;
  const d = document.getElementById('pf-name-lg'); if (d) d.textContent = trimmed;
}
function updateProfileInitials(v) {
  const trimmed = v.trim().toUpperCase();
  if (!SESSION || !trimmed) return;
  SESSION.initials = trimmed;
  const av  = document.getElementById('sb-av');    if (av)  av.textContent  = trimmed;
  const av2 = document.getElementById('pf-av-sm'); if (av2) av2.textContent = trimmed;
  const av3 = document.getElementById('pf-av-lg'); if (av3) av3.textContent = trimmed;
}

function settingsAppearance() {
  const isSystem = THEME === 'system';
  const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = THEME === 'dark' || (isSystem && sysDark);
  const fallback = isDark ? 'dark' : 'light';
  return `
    <div class="settings-section">
      <div class="settings-h">Theme</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px">Light or dark palette, or follow your operating system.</div>
      <div class="settings-row">
        <div>
          <div style="font-size:13px;font-weight:500;color:var(--ink)">Dark mode</div>
          <div style="font-size:11px;color:var(--ink3);margin-top:2px">Use a darker color palette across the app${isSystem?' — currently controlled by system preference':''}</div>
        </div>
        <label class="toggle">
          <input type="checkbox" ${isDark?'checked':''} ${isSystem?'disabled':''} onchange="setTheme(this.checked?'dark':'light');renderPage('settings')">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="settings-row">
        <div>
          <div style="font-size:13px;font-weight:500;color:var(--ink)">Match system preference</div>
          <div style="font-size:11px;color:var(--ink3);margin-top:2px">Automatically switch when your operating system changes themes</div>
        </div>
        <label class="toggle">
          <input type="checkbox" ${isSystem?'checked':''} onchange="setTheme(this.checked?'system':'${fallback}');renderPage('settings')">
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-h">Page chrome</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px">Click the small caret in the top-right of any KPI bar, filter bar, or tab bar to collapse it. Collapsed sections shrink to a one-line "▸ Show …" pill — click anywhere on the pill to expand again. Choices stick across reloads.</div>
      <div class="settings-row">
        <div>
          <div style="font-size:13px;font-weight:500;color:var(--ink)">Hidden sections</div>
          <div style="font-size:11px;color:var(--ink3);margin-top:2px">${COLLAPSED_SECTIONS.size} section${COLLAPSED_SECTIONS.size===1?'':'s'} collapsed across pages</div>
        </div>
        <button class="btn btn-sm" ${COLLAPSED_SECTIONS.size===0?'disabled':''} onclick="resetAllCollapsedSections()">Show all</button>
      </div>
    </div>`;
}

function settingsNotifications() {
  const types = [
    {k:'breach',    l:'SLA breach',    d:'Tickets that have exceeded their SLA window'},
    {k:'escalated', l:'Escalations',   d:'Tickets escalated to senior agents'},
    {k:'gdpr',      l:'GDPR requests', d:'Data subject access and erasure requests'},
    {k:'warn',      l:'SLA warnings',  d:'Tickets approaching SLA breach'},
    {k:'wake',      l:'Snooze wake-ups', d:'Tickets that have come back from a snooze'},
    {k:'mention',   l:'@mentions',     d:'You were @-mentioned in an internal note'},
  ];
  return `
    <div class="settings-section">
      <div class="settings-h">Notification types</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px">Choose which alerts appear in the notifications bell.</div>
      ${types.map(t => `
        <div class="settings-row">
          <div>
            <div style="font-size:13px;font-weight:500;color:var(--ink)">${t.l}</div>
            <div style="font-size:11px;color:var(--ink3);margin-top:2px">${t.d}</div>
          </div>
          <label class="toggle">
            <input type="checkbox" ${NOTIF_PREFS[t.k]?'checked':''} onchange="toggleNotifPref('${t.k}',this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>`).join('')}
    </div>`;
}

function toggleNotifPref(k, v) {
  NOTIF_PREFS[k] = v;
  localStorage.setItem('notif_prefs', JSON.stringify(NOTIF_PREFS));
  refreshNotifBadge();
}

function settingsAI() {
  const models = [
    {v:'claude-opus-4-7',  l:'Claude Opus 4.7'},
    {v:'claude-sonnet-4-6',l:'Claude Sonnet 4.6'},
    {v:'claude-haiku-4-5', l:'Claude Haiku 4.5'},
  ];
  return `
    <div class="settings-section">
      <div class="settings-h">Claude API</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">Used by the <strong style="color:var(--ink2)">AI Draft</strong> button in the ticket composer. Stored locally in your browser — never sent to our servers.</div>
      <div class="form-row">
        <label class="form-label">API key</label>
        <input class="form-input" type="password" id="set-ai-key" value="${AI_API_KEY}" placeholder="sk-ant-…" oninput="setAIKey(this.value)" autocomplete="off"/>
      </div>
      <div class="form-row">
        <label class="form-label">Model</label>
        <select class="form-input" onchange="setAIModel(this.value)">
          ${models.map(m => `<option value="${m.v}" ${AI_MODEL===m.v?'selected':''}>${m.l}</option>`).join('')}
        </select>
      </div>
      <div style="font-size:11px;color:${AI_API_KEY?'var(--green)':'var(--ink3)'};font-family:'DM Mono',monospace;margin-top:8px">
        ${AI_API_KEY ? '✓ Key saved' : 'No key configured — AI Draft will return a fallback message'}
      </div>
    </div>`;
}

function settingsKnowledgeBase() {
  const cfg = KB_INTEGRATION;
  const esc = s => String(s||'').replace(/"/g,'&quot;');
  const testState = KB_TEST_STATE || null;
  return `
    <div class="settings-section">
      <div class="settings-h">External Knowledge Base</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">Connect a third-party KB so the composer can ground AI replies in your own articles. Configure the endpoint + JSON field mapping; the adapter is generic and works with any REST API that returns a list of articles per query.</div>
      <div style="font-size:11px;color:var(--amber);background:var(--amber-lt);border:1px solid var(--amber);border-radius:var(--r);padding:8px 10px;margin-bottom:14px;line-height:1.5">
        <strong>Security notes.</strong> The API key is held in browser <code style="font-family:'DM Mono',monospace">localStorage</code> on this device — anyone with access to this browser profile can read it. Point the base URL at an external KB only; internal IPs or non-HTTPS hosts are blocked from most browser fetch contexts and shouldn't be used. Audit your KB content for prompt-injection — KB excerpts are clearly marked as untrusted data when sent to Claude, but reviewers should still vet what the model can see.
      </div>
      <div class="settings-row">
        <div>
          <div style="font-size:13px;font-weight:500;color:var(--ink)">Integration enabled</div>
          <div style="font-size:11px;color:var(--ink3);margin-top:2px">When on, the composer shows an "AI Reply with KB" action and the ticket sidebar lists matching articles.</div>
        </div>
        <label class="toggle"><input type="checkbox" ${cfg.enabled?'checked':''} onchange="setKbCfg('enabled',this.checked)"><span class="toggle-slider"></span></label>
      </div>
      <div class="form-row"><label class="form-label">Base URL</label>
        <input class="form-input" id="kb-base-url" placeholder="https://kb.example.com/api/v1" value="${esc(cfg.baseUrl)}" oninput="setKbCfg('baseUrl',this.value)"/>
      </div>
      <div class="form-row"><label class="form-label">Search path <span style="color:var(--ink3);font-family:'DM Mono',monospace;font-size:11px;font-weight:400">— use {query} as placeholder</span></label>
        <input class="form-input" id="kb-search-path" placeholder="/articles?q={query}&amp;limit=5" value="${esc(cfg.searchPath)}" oninput="setKbCfg('searchPath',this.value)"/>
      </div>
      <div class="form-grid">
        <div class="form-row"><label class="form-label">Auth header (optional)</label>
          <input class="form-input" placeholder="Authorization" value="${esc(cfg.authHeader)}" oninput="setKbCfg('authHeader',this.value)"/>
        </div>
        <div class="form-row"><label class="form-label">Header prefix</label>
          <input class="form-input" placeholder="Bearer " value="${esc(cfg.authPrefix)}" oninput="setKbCfg('authPrefix',this.value)"/>
        </div>
      </div>
      <div class="form-row"><label class="form-label">API key / token (optional)</label>
        <input class="form-input" type="password" placeholder="—" value="${esc(cfg.apiKey)}" oninput="setKbCfg('apiKey',this.value)" autocomplete="off"/>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-h">Response shape</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">Tell the adapter where to find articles inside the JSON response. Field names support dot notation (e.g. <code style="font-family:'DM Mono',monospace">data.items</code>).</div>
      <div class="form-grid">
        <div class="form-row"><label class="form-label">Results path</label>
          <input class="form-input" placeholder="(empty = response root)" value="${esc(cfg.resultsField)}" oninput="setKbCfg('resultsField',this.value)"/>
        </div>
        <div class="form-row"><label class="form-label">Max results</label>
          <input class="form-input" type="number" min="1" max="20" value="${cfg.maxResults}" oninput="setKbCfg('maxResults',parseInt(this.value,10)||3)"/>
        </div>
      </div>
      <div class="form-grid">
        <div class="form-row"><label class="form-label">ID field</label><input class="form-input" value="${esc(cfg.idField)}" oninput="setKbCfg('idField',this.value)"/></div>
        <div class="form-row"><label class="form-label">Title field</label><input class="form-input" value="${esc(cfg.titleField)}" oninput="setKbCfg('titleField',this.value)"/></div>
      </div>
      <div class="form-grid">
        <div class="form-row"><label class="form-label">Body field</label><input class="form-input" value="${esc(cfg.bodyField)}" oninput="setKbCfg('bodyField',this.value)"/></div>
        <div class="form-row"><label class="form-label">URL field</label><input class="form-input" value="${esc(cfg.urlField)}" oninput="setKbCfg('urlField',this.value)"/></div>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-h">Test connection</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">Send a sample query against the configured endpoint to verify the path, auth, and field mapping.</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input class="form-input" id="kb-test-q" placeholder="e.g. password reset" style="flex:1;min-width:200px" value="${esc(testState?.query || 'password reset')}"/>
        <button class="btn btn-sm" onclick="testKbConnection()" ${cfg.enabled?'':'disabled'}>Run test</button>
      </div>
      ${testState ? `
        <div style="margin-top:14px;padding:12px;border:1px solid ${testState.error?'var(--red)':'var(--green)'};border-radius:var(--r);background:${testState.error?'var(--red-lt)':'var(--green-lt)'}">
          ${testState.error ? `<div style="font-size:12px;color:var(--red);font-family:'DM Mono',monospace">${escHtml(testState.error)}</div>` : `
            <div style="font-size:12px;color:var(--green);font-weight:500;margin-bottom:8px">✓ ${testState.articles.length} article${testState.articles.length===1?'':'s'} returned</div>
            ${testState.articles.map(a => `<div style="padding:6px 8px;background:var(--off);border:1px solid var(--rule);border-radius:3px;margin-bottom:4px"><div style="font-size:12px;font-weight:500;color:var(--ink)">${escHtml(a.title)}</div><div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);margin-top:2px">${escHtml(a.id)} · ${escHtml(a.url || '(no url)')}</div></div>`).join('')}
          `}
        </div>` : ''}
    </div>`;
}

function setKbCfg(key, value) {
  KB_INTEGRATION[key] = value;
  saveKbIntegration();
  KB_TICKET_CACHE.clear();
}

async function testKbConnection() {
  const q = document.getElementById('kb-test-q')?.value?.trim() || 'password reset';
  KB_TEST_STATE = { query: q, loading: true };
  renderPage('settings');
  const result = await fetchKbArticles(q);
  KB_TEST_STATE = { query: q, articles: result.articles || [], error: result.error || null };
  renderPage('settings');
}

function settingsLanguage() {
  return `
    <div class="settings-section">
      <div class="settings-h">Your reading language</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">When ticket-thread translation is enabled (toggle above the conversation), customer messages render in this language. Replies you compose can also be auto-translated to the customer's language before sending. Detection and translation use the Claude API key configured in <span class="link" onclick="setSettingsTab('ai')">AI Assistant</span>.</div>
      <div class="form-row">
        <label class="form-label">Preferred language</label>
        <select class="form-input" id="set-pref-lang" onchange="setAgentPreferredLang(this.value)">
          ${TRANSLATOR_LANGS.map(l => `<option value="${l}" ${AGENT_PREFERRED_LANG===l?'selected':''}>${l}</option>`).join('')}
        </select>
      </div>
      <div style="font-size:11px;color:${AI_API_KEY?'var(--green)':'var(--amber)'};font-family:'DM Mono',monospace;margin-top:8px">
        ${AI_API_KEY ? `✓ Currently set to ${AGENT_PREFERRED_LANG}` : 'Add an API key in AI Assistant to enable detection and translation.'}
      </div>
    </div>`;
}


// ─── Knowledge Base ──────────────────────────────────────────────────────────
let KB_QUERY = '';
let KB_FILTER_CAT = 'all';


function articleSnippet(a) { return a.body.replace(/\n+/g, ' ').slice(0, 180); }

let KB_VOTES = (() => { try { return JSON.parse(localStorage.getItem('kb_votes') || '{}'); } catch { return {}; } })();
let KB_USER_VOTES = (() => { try { return JSON.parse(localStorage.getItem('kb_user_votes') || '{}'); } catch { return {}; } })();
let KB_VIEWS = (() => { try { return JSON.parse(localStorage.getItem('kb_views') || '{}'); } catch { return {}; } })();

function saveKBState() {
  try {
    localStorage.setItem('kb_votes',      JSON.stringify(KB_VOTES));
    localStorage.setItem('kb_user_votes', JSON.stringify(KB_USER_VOTES));
    localStorage.setItem('kb_views',      JSON.stringify(KB_VIEWS));
  } catch {}
}

function getKBViews(id) {
  if (KB_VIEWS[id] != null) return KB_VIEWS[id];
  // Deterministic seed so it doesn't change between renders
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return 50 + (h % 350);
}
function incrementKBView(id) {
  KB_VIEWS[id] = getKBViews(id) + 1;
  saveKBState();
}

function readingTime(body) {
  const words = (body || '').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

function voteKB(id, dir) {
  const prev = KB_USER_VOTES[id];
  let v = KB_VOTES[id] || 0;
  if (prev === dir) {
    v -= dir === 'up' ? 1 : -1;
    delete KB_USER_VOTES[id];
  } else if (prev) {
    v += (dir === 'up' ? 2 : -2);
    KB_USER_VOTES[id] = dir;
  } else {
    v += dir === 'up' ? 1 : -1;
    KB_USER_VOTES[id] = dir;
  }
  KB_VOTES[id] = v;
  saveKBState();
  renderPage('kb');
}

function toggleKBFeatured(id) {
  if (!isAdmin()) return;
  const a = KB_ARTICLES.find(x => x.id === id);
  if (!a) return;
  a.featured = !a.featured;
  renderPage('kb');
}

function getRelatedArticles(article) {
  const tokens = (article.title + ' ' + article.body).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3);
  const tokenSet = new Set(tokens);
  const scored = KB_ARTICLES.filter(a => a.id !== article.id).map(a => {
    let score = 0;
    if (a.category === article.category) score += 5;
    const aTokens = (a.title + ' ' + a.body).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3);
    aTokens.forEach(t => { if (tokenSet.has(t)) score += 1; });
    return { a, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
  return scored.map(x => x.a);
}

function highlightSearch(text, query) {
  if (!query || !query.trim()) return text;
  const terms = query.trim().split(/\s+/).filter(t => t.length > 1);
  let out = text;
  terms.forEach(term => {
    const re = new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    out = out.replace(re, '<mark>$1</mark>');
  });
  return out;
}

function renderKB() {
  if (KB_SELECTED) return renderKBArticle(KB_SELECTED);
  const admin = isAdmin();
  const ql = KB_QUERY.toLowerCase().trim();

  let list = KB_ARTICLES.filter(a => KB_FILTER_CAT === 'all' || a.category === KB_FILTER_CAT);
  if (ql) list = list.filter(a => a.title.toLowerCase().includes(ql) || a.body.toLowerCase().includes(ql) || a.category.toLowerCase().includes(ql) || a.id.toLowerCase().includes(ql));
  list.sort((a, b) => {
    if (a.featured && !b.featured) return -1;
    if (!a.featured && b.featured) return 1;
    return (b.updated || '').localeCompare(a.updated || '');
  });

  const cards = list.map(a => {
    const views = getKBViews(a.id);
    const votes = KB_VOTES[a.id] || 0;
    const titleHtml   = ql ? highlightSearch(escHtml(a.title),         KB_QUERY) : escHtml(a.title);
    const snippetHtml = ql ? highlightSearch(escHtml(articleSnippet(a)), KB_QUERY) : escHtml(articleSnippet(a));
    return `
      <div class="kb-card" onclick="openKBArticle('${a.id}')">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
          <div class="kb-card-cat" style="margin:0">${a.category}</div>
          ${a.featured ? '<span style="font-size:9px;color:var(--amber);text-transform:uppercase;letter-spacing:.06em;font-weight:600">★ Featured</span>' : ''}
        </div>
        <div class="kb-card-t">${titleHtml}</div>
        <div class="kb-card-snippet">${snippetHtml}</div>
        <div class="kb-card-meta">
          <span>${a.id}</span>
          <span style="display:flex;gap:10px;align-items:center">
            <span title="Views">${views} view${views===1?'':'s'}</span>
            ${votes !== 0 ? `<span style="color:${votes>0?'var(--green)':'var(--red)'}" title="Helpful score">${votes>0?'+':''}${votes}</span>` : ''}
          </span>
        </div>
      </div>`;
  }).join('');

  const catCounts = {};
  KB_ARTICLES.forEach(a => { catCounts[a.category] = (catCounts[a.category] || 0) + 1; });
  const sortedCats = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Knowledge Base</div>
        ${admin ? `<button class="btn btn-solid btn-sm" onclick="kbNewArticle()">+ New Article</button>` : ''}
      </div>
      <div class="kb-layout">
        <aside class="kb-sidebar">
          <div style="padding:12px 14px;border-bottom:1px solid var(--rule)">
            <div class="ts-heading" style="margin:0">Categories</div>
          </div>
          <div class="kb-cat-list">
            <div class="kb-cat-item ${KB_FILTER_CAT==='all'?'active':''}" onclick="kbSetCat('all')">
              <span class="kb-cat-name">All articles</span>
              <span class="kb-cat-count">${KB_ARTICLES.length}</span>
            </div>
            ${sortedCats.map(([cat, count]) => `
              <div class="kb-cat-item ${KB_FILTER_CAT===cat?'active':''}" onclick="kbSetCat('${escAttr(cat)}')">
                <span class="kb-cat-name">${cat}</span>
                <span class="kb-cat-count">${count}</span>
              </div>`).join('')}
          </div>
        </aside>
        <div class="kb-main">
          <div class="filter-bar">
            <span class="filter-label">Search</span>
            <input class="filter-select" placeholder="Search articles…" style="width:280px" value="${KB_QUERY}" oninput="kbSetQuery(this.value)"/>
            <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${KB_ARTICLES.length} articles${KB_FILTER_CAT!=='all'?` · ${KB_FILTER_CAT}`:''}</span>
          </div>
          <div class="page-scroll">
            ${list.length ? `<div class="kb-grid">${cards}</div>` : `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No articles match</div><div class="empty-line"></div></div>`}
          </div>
        </div>
      </div>
    </div>`;
}

function renderKBArticle(id) {
  const a = KB_ARTICLES.find(x => x.id === id);
  if (!a) { KB_SELECTED = null; return renderKB(); }
  const admin = isAdmin();
  const views = getKBViews(id);
  const votes = KB_VOTES[id] || 0;
  const userVote = KB_USER_VOTES[id];
  const reading = readingTime(a.body);
  const wordCount = (a.body || '').split(/\s+/).filter(Boolean).length;
  const related = getRelatedArticles(a);
  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-breadcrumb">
          <span onclick="closeKBArticle()">Knowledge Base</span>
          <span class="tb-sep">/</span>
          <span style="color:var(--ink);font-weight:500">${a.id}</span>
          ${admin ? `<span style="margin-left:auto;display:flex;gap:6px">
            <button class="btn btn-sm" onclick="toggleKBFeatured('${a.id}')">${a.featured?'★ Unfeature':'☆ Feature'}</button>
            <button class="btn btn-sm" onclick="kbEditArticle('${a.id}')">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="kbDeleteArticle('${a.id}')">Delete</button>
          </span>` : ''}
        </div>
      </div>
      <div class="page-scroll">
        <div class="kb-article">
          <div class="kb-card-cat" style="display:flex;align-items:center;gap:8px">
            <span>${a.category}</span>
            ${a.featured ? '<span style="color:var(--amber);font-weight:600">★ Featured</span>' : ''}
          </div>
          <h1 class="kb-article-h">${a.title}</h1>
          <div class="kb-article-meta">
            <span>${a.id}</span>
            <span>By ${a.author}</span>
            <span>Updated ${a.updated}</span>
            <span>${views} view${views===1?'':'s'}</span>
            <span>${reading} min read · ${wordCount} words</span>
            ${votes !== 0 ? `<span style="color:${votes>0?'var(--green)':'var(--red)'}">${votes>0?'+':''}${votes} helpful</span>` : ''}
          </div>
          <div class="ai-md">${renderMarkdown(a.body)}</div>

          <div class="kb-helpful-card">
            <div style="font-size:13px;font-weight:500;color:var(--ink);margin-bottom:12px">Was this article helpful?</div>
            <div style="display:flex;gap:10px;justify-content:center;align-items:center;flex-wrap:wrap">
              <button class="btn btn-sm" onclick="voteKB('${a.id}','up')" style="${userVote==='up'?'border-color:var(--green);color:var(--green);background:var(--green-lt)':''}">👍 Yes</button>
              <button class="btn btn-sm" onclick="voteKB('${a.id}','down')" style="${userVote==='down'?'border-color:var(--red);color:var(--red);background:var(--red-lt)':''}">👎 No</button>
              ${votes !== 0 ? `<span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:8px">Net score: ${votes>0?'+':''}${votes}</span>` : ''}
            </div>
          </div>

          ${related.length ? `
          <div style="margin-top:28px">
            <div class="ts-heading" style="margin-bottom:10px">Related articles</div>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px">
              ${related.map(r => `
                <div class="kb-card" onclick="openKBArticle('${r.id}')" style="padding:12px">
                  <div class="kb-card-cat" style="margin-bottom:6px">${r.category}</div>
                  <div class="kb-card-t" style="font-size:13px">${r.title}</div>
                </div>`).join('')}
            </div>
          </div>` : ''}
        </div>
      </div>
    </div>`;
}

function kbSetQuery(q) {
  const wasFocused = document.activeElement;
  KB_QUERY = q;
  renderPage('kb');
  // restore focus to the input that had it
  const input = document.querySelector('.filter-bar input');
  if (input && wasFocused?.tagName === 'INPUT') {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}
function kbSetCat(c) { KB_FILTER_CAT = c; renderPage('kb'); }
function openKBArticle(id) { incrementKBView(id); KB_SELECTED = id; renderPage('kb'); }
function closeKBArticle()  { KB_SELECTED = null; renderPage('kb'); }

function kbArticleForm(initial) {
  const cats = [...new Set(KB_ARTICLES.map(a => a.category))];
  const a = initial || {title:'', category:cats[0]||'Getting Started', body:''};
  return `
    <div class="form-row"><label class="form-label">Title</label><input class="form-input" id="kb-title" value="${a.title.replace(/"/g,'&quot;')}"/></div>
    <div class="form-row"><label class="form-label">Category</label>
      <input class="form-input" id="kb-cat" list="kb-cat-list" value="${a.category.replace(/"/g,'&quot;')}"/>
      <datalist id="kb-cat-list">${cats.map(c => `<option value="${c}">`).join('')}</datalist>
    </div>
    <div class="form-row"><label class="form-label">Body</label><textarea class="form-input" id="kb-body" style="min-height:240px;font-family:'Inter',sans-serif">${a.body}</textarea></div>`;
}

function kbNewArticle() {
  if (!isAdmin()) return;
  showModal('New article', kbArticleForm(null), () => {
    const title = document.getElementById('kb-title').value.trim();
    const cat   = document.getElementById('kb-cat').value.trim() || 'Getting Started';
    const body  = document.getElementById('kb-body').value;
    if (!title || !body.trim()) return;
    const id = 'KB-' + String(KB_ARTICLES.length + 1).padStart(3, '0');
    KB_ARTICLES.unshift({id, title, category:cat, body, author:SESSION?.name||'Unknown', updated:new Date().toISOString().slice(0,10)});
    closeModal(); renderPage('kb');
  }, 'Publish', true);
}

function kbEditArticle(id) {
  if (!isAdmin()) return;
  const a = KB_ARTICLES.find(x => x.id === id); if (!a) return;
  showModal('Edit article', kbArticleForm(a), () => {
    const title = document.getElementById('kb-title').value.trim();
    const cat   = document.getElementById('kb-cat').value.trim() || a.category;
    const body  = document.getElementById('kb-body').value;
    if (!title || !body.trim()) return;
    a.title = title; a.category = cat; a.body = body;
    a.updated = new Date().toISOString().slice(0,10);
    closeModal(); renderPage('kb');
  }, 'Save changes', true);
}

function kbDeleteArticle(id) {
  if (!isAdmin()) return;
  const a = KB_ARTICLES.find(x => x.id === id); if (!a) return;
  showModal('Delete article', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${a.title}</strong>? This cannot be undone.</div>`, () => {
    const i = KB_ARTICLES.findIndex(x => x.id === id);
    if (i >= 0) KB_ARTICLES.splice(i, 1);
    KB_SELECTED = null;
    closeModal(); renderPage('kb');
  }, 'Delete');
}

// ─── Help & Support ──────────────────────────────────────────────────────────
const HELP_FAQ_OPEN = new Set();

function navTo(page) {
  let target = null;
  document.querySelectorAll('.sb-item').forEach(i => {
    const a = i.getAttribute('onclick') || '';
    if (a.includes(`'${page}'`)) target = i;
  });
  nav(page, target);
}

function focusGlobalSearch() {
  const input = document.getElementById('gs-input');
  if (input) { input.focus(); input.select(); }
}

function renderHelp() {
  return `
    <div class="page">
      <div class="topbar"><div class="tb-title">Help & Support</div></div>
      <div class="page-scroll">
        <div class="help-grid">
          ${helpQuickStart()}
          ${helpShortcuts()}
        </div>
        ${helpFAQ()}
        ${helpContact()}
      </div>
    </div>`;
}

function helpQuickStart() {
  const items = [
    {t:'Manage tickets',     d:'Triage, reply, escalate or resolve customer requests',                    a:"navTo('tickets')"},
    {t:'AI-assisted replies',d:'Add your Claude API key in Settings → AI to enable AI Draft',             a:"navTo('settings');setSettingsTab('ai')"},
    {t:'Roles & permissions',d:'Define custom roles, assign agents, control access per area',             a:"navTo('roles')"},
    {t:'Global search',      d:"Press / from anywhere to search tickets, customers, agents, and pages",   a:"focusGlobalSearch()"},
  ];
  return `
    <div class="card">
      <div class="card-title">Quick start</div>
      <div class="help-quickstart">
        ${items.map(i => `<div class="help-card" onclick="${i.a}"><div class="help-card-t">${i.t}</div><div class="help-card-d">${i.d}</div></div>`).join('')}
      </div>
    </div>`;
}

function helpShortcuts() {
  const shortcuts = [
    {k:'/',     d:'Focus the global search bar'},
    {k:'↑ / ↓', d:'Navigate search results'},
    {k:'Enter', d:'Open the highlighted result'},
    {k:'Esc',   d:'Close the search dropdown'},
  ];
  return `
    <div class="card">
      <div class="card-title">Keyboard shortcuts</div>
      <table class="tbl" style="margin-top:6px">
        <tbody>${shortcuts.map(s => `<tr><td style="width:90px"><span class="help-kbd">${s.k}</span></td><td>${s.d}</td></tr>`).join('')}</tbody>
      </table>
    </div>`;
}

function helpFAQ() {
  const faqs = [
    {q:'How do I add a new agent?',                       a:'Go to <strong>Roles & Permissions</strong>, click into a role, then use the <strong>+ Agent</strong> button. Admin access is required.'},
    {q:'Why does AI Draft show "no key configured"?',     a:'AI Draft uses the Claude API. Add your key in <strong>Settings → AI Assistant</strong>. The key is stored only in your browser localStorage and never sent to our servers.'},
    {q:'Can I create a custom permission?',                a:'Yes — <strong>Roles & Permissions → + Permission</strong>. The new permission is added as a column on every existing role with default off, ready for you to grant per-role.'},
    {q:'How are notifications generated?',                 a:'They are derived from current ticket state in real time: SLA breach, escalations, GDPR requests, and SLA warnings. Toggle which types appear in <strong>Settings → Notifications</strong>.'},
    {q:'Does my data sync across devices?',                a:'No — this demo stores state in your browser. Theme, notification preferences, and AI key persist via localStorage. Tickets, customers, and roles reset on reload.'},
    {q:'How do I delete a role?',                          a:'<strong>Roles & Permissions →</strong> click <strong>Delete</strong> next to the role. All agents must be reassigned off the role first. The Admin role is protected and cannot be deleted.'},
    {q:'Can a Read Only agent edit anything?',             a:'No — Read Only agents see all read-only views (matrix, settings, etc.) but the toggles, edit buttons, and delete actions are hidden or disabled.'},
  ];
  return `
    <div class="card" style="margin-top:16px">
      <div class="card-title">Frequently asked questions</div>
      <div style="margin-top:6px">
        ${faqs.map((f,i) => `
          <div class="help-faq-item">
            <div class="help-faq-q" onclick="toggleFAQ(${i})">
              <span>${f.q}</span>
              <span class="help-faq-chev">${HELP_FAQ_OPEN.has(i)?'−':'+'}</span>
            </div>
            ${HELP_FAQ_OPEN.has(i)?`<div class="help-faq-a">${f.a}</div>`:''}
          </div>`).join('')}
      </div>
    </div>`;
}

function toggleFAQ(i) {
  if (HELP_FAQ_OPEN.has(i)) HELP_FAQ_OPEN.delete(i); else HELP_FAQ_OPEN.add(i);
  renderPage('help');
}

function helpContact() {
  return `
    <div class="card" style="margin-top:16px">
      <div class="card-title">Contact support</div>
      <div style="font-size:12px;color:var(--ink3);margin-bottom:14px">Can't find what you need? Send us a message and we'll get back to you within one business day.</div>
      <div class="form-grid">
        <div class="form-row"><label class="form-label">Your name</label><input class="form-input" id="sup-name" value="${SESSION?.name||''}"/></div>
        <div class="form-row"><label class="form-label">Reply-to email</label><input class="form-input" id="sup-email" type="email" placeholder="you@company.com"/></div>
      </div>
      <div class="form-row"><label class="form-label">Subject</label>
        <select class="form-input" id="sup-subj">
          <option>Question about a feature</option>
          <option>Bug report</option>
          <option>Account issue</option>
          <option>Billing</option>
          <option>Other</option>
        </select>
      </div>
      <div class="form-row"><label class="form-label">Message</label><textarea class="form-input" id="sup-msg" placeholder="Describe what you need help with…" style="min-height:100px"></textarea></div>
      <div style="display:flex;gap:10px;align-items:center">
        <button class="btn btn-solid" onclick="submitSupport()">Send message</button>
        <span id="sup-confirm" style="font-size:11px;color:var(--green);font-family:'DM Mono',monospace;display:none">Message sent — we'll be in touch.</span>
      </div>
    </div>`;
}

function submitSupport() {
  const name = document.getElementById('sup-name')?.value.trim();
  const msg  = document.getElementById('sup-msg')?.value.trim();
  if (!name || !msg) return;
  const box = document.getElementById('sup-msg'); if (box) box.value = '';
  const c = document.getElementById('sup-confirm'); if (c) c.style.display = 'inline';
  setTimeout(() => { const el = document.getElementById('sup-confirm'); if (el) el.style.display = 'none'; }, 4000);
}

document.addEventListener('keydown', e => {
  if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
    const tag = document.activeElement?.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
      const input = document.getElementById('gs-input');
      if (input) { e.preventDefault(); input.focus(); input.select(); }
    }
  }
  // Cmd+K / Ctrl+K opens the quick switcher from anywhere — including inside
  // text inputs, since this is the standard shortcut agents reach for.
  if (e.key === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey) {
    e.preventDefault();
    toggleQuickSwitcher(true);
  }
});

// ─── Cmd+K quick switcher ───────────────────────────────────────────────────
// Keyboard-first overlay that fuzzy-matches the query against pages, tickets,
// customers, agents, and KB articles. Up/Down navigate, Enter opens the
// active result, Esc dismisses. Designed to be the fastest path through the
// app for an agent who knows what they're looking for.
let QS_OPEN = false;
let QS_QUERY = '';
let QS_ACTIVE_INDEX = 0;
let QS_RESULTS = [];

function toggleQuickSwitcher(open) {
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
  // Always show pages so empty query lists the full nav surface.
  const pages = (typeof SEARCH_PAGES !== 'undefined' ? SEARCH_PAGES : []).map(p => ({
    kind: 'page', label: p.l, sub: p.p, payload: { page: p.p },
  }));
  if (!q) {
    return [
      { group: 'Pages', items: pages.slice(0, 12) },
    ];
  }
  const match = text => text && String(text).toLowerCase().includes(q);
  const pageHits = pages.filter(p => match(p.label) || match(p.sub));
  // Guard these globals symmetrically with SEARCH_PAGES / KB_ARTICLES so the
  // switcher renders cleanly even if a future refactor delays one of them.
  const TKS = (typeof TICKETS    !== 'undefined' ? TICKETS    : []);
  const CUS = (typeof CUSTOMERS  !== 'undefined' ? CUSTOMERS  : []);
  const AGS = (typeof AGENTS     !== 'undefined' ? AGENTS     : []);
  const tickets = TKS.filter(t => match(t.id) || match(t.subject) || match(t.agent) || (t.tags || []).some(match)).slice(0, 10).map(t => ({
    kind: 'ticket',
    label: t.subject,
    sub: `${t.id} · ${t.status} · ${t.priority}${t.agent ? ' · ' + t.agent : ''}`,
    payload: { ticketId: t.id },
  }));
  const customers = CUS.filter(c => match(c.first + ' ' + c.last) || match(c.id) || match(c.email) || match(c.brand)).slice(0, 8).map(c => ({
    kind: 'customer',
    label: `${c.first} ${c.last}`,
    sub: `${c.id} · ${c.brand || ''} · ${c.email || ''}`.replace(/\s·\s$/, ''),
    payload: { customerId: c.id },
  }));
  const agents = AGS.filter(a => match(a.name) || match(a.role)).slice(0, 6).map(a => ({
    kind: 'agent',
    label: a.name,
    sub: `${a.role}${isAgentOOO?.(a.name) ? ' · OOO' : ''}`,
    payload: { agentName: a.name },
  }));
  const kbs = (typeof KB_ARTICLES !== 'undefined' ? KB_ARTICLES : []).filter(a => match(a.title) || match(a.category)).slice(0, 6).map(a => ({
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
    <div class="qs-group">${escHtml(g.group)}</div>
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
          <span class="qs-label">${escHtml(item.label)}</span>
          <span class="qs-sub">${escHtml(item.sub || '')}</span>
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
        <input id="qs-input" class="qs-input" placeholder="Jump to a ticket, customer, agent, KB article, or page…" value="${escHtml(QS_QUERY)}"
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
  if (item.kind === 'page')     navTo(item.payload.page);
  else if (item.kind === 'ticket')   openTicket(item.payload.ticketId);
  else if (item.kind === 'customer') { CUSTOMER_SELECTED = item.payload.customerId; navTo('customers'); }
  else if (item.kind === 'agent')    { AGENT_SELECTED = item.payload.agentName; navTo('agents'); }
  else if (item.kind === 'kb')       { KB_SELECTED = item.payload.kbId; navTo('kb'); }
}

// ─── Stub pages (placeholders so sidebar nav renders) ────────────────────────
function placeholderPage(title, blurb) {
  return `
    <div class="page">
      <div class="topbar"><div class="tb-title">${title}</div></div>
      <div class="page-scroll">
        <div class="card" style="max-width:520px;margin:40px auto;text-align:center">
          <div class="card-title" style="margin-bottom:10px">${title}</div>
          <div style="font-size:13px;color:var(--ink3);line-height:1.6">${blurb}</div>
        </div>
      </div>
    </div>`;
}
function openAgentFromDash(name) { AGENT_SELECTED = name; navTo('agents'); }
function openKBFromDash(id)      { KB_SELECTED = id; navTo('kb'); }

function dashRecentTickets() {
  const tickets = [...TICKETS].slice(0, 6);
  const rows = tickets.map(t => `
    <div onclick="openTicket('${escAttr(t.id)}')" style="padding:9px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;display:flex;gap:10px;align-items:center;background:var(--off2);margin-bottom:6px;transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
      <span class="tag tag-${t.status}" style="font-size:9px">${t.status}</span>
      <span class="tag tag-${t.priority}" style="font-size:9px">${t.priority}</span>
      <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);flex-shrink:0">${t.id}</span>
      <span style="flex:1;font-size:12px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500">${t.subject}</span>
      <span class="sla-${t.sla}" style="font-size:10px;text-transform:uppercase;font-weight:500;flex-shrink:0">${t.sla}</span>
      <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);flex-shrink:0">${t.updated}</span>
    </div>`).join('');
  return `
    <div class="card span-8">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="card-title" style="margin:0">Recent activity</div>
        <span class="link" onclick="navTo('tickets')" style="font-size:11px">View all →</span>
      </div>
      ${rows || '<div style="color:var(--ink3);font-size:12px">No tickets yet</div>'}
    </div>`;
}

// Render a categorical breakdown as bar / donut / list. Used by the dash and
// report widgets that have a `charts:['bar','donut','list']` registry entry.
function renderCategoricalChart(items, colorFor, chart) {
  const total = items.reduce((sum, [, v]) => sum + v, 0);
  const legend = items.map(([k, v]) => `<div class="donut-row" style="font-size:11px"><span class="donut-dot" style="background:${colorFor(k)}"></span><span style="flex:1;text-transform:capitalize;color:var(--ink2)">${escHtml(k)}</span><span style="font-family:'DM Mono',monospace;color:var(--ink3)">${v}</span></div>`).join('');
  if (chart === 'list') return legend || '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:16px 0">No data</div>';
  if (chart === 'donut') {
    if (!total) return `<div style="color:var(--ink3);font-size:12px;text-align:center;padding:16px 0">No data</div>${legend}`;
    const r = 36, c = 2 * Math.PI * r;
    let off = 0;
    const arcs = items.map(([k, v]) => {
      const len = (v / total) * c;
      const seg = `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${colorFor(k)}" stroke-width="14" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-off}" transform="rotate(-90 50 50)"/>`;
      off += len;
      return seg;
    }).join('');
    return `
      <div style="display:flex;gap:14px;align-items:center;margin-bottom:8px">
        <svg width="100" height="100" viewBox="0 0 100 100" style="flex-shrink:0">${arcs}<text x="50" y="55" text-anchor="middle" font-family="Inter" font-size="14" font-weight="600" fill="var(--ink)">${total}</text></svg>
        <div style="flex:1">${legend}</div>
      </div>`;
  }
  // Default: stacked horizontal bar + legend below.
  const segs = items.map(([k, v]) => {
    const pct = total ? (v / total) * 100 : 0;
    return `<div title="${escHtml(k)}: ${v}" style="background:${colorFor(k)};width:${pct}%"></div>`;
  }).join('');
  return `<div class="r-stack">${segs}</div><div style="margin-top:12px">${legend}</div>`;
}

function dashStatus(s) {
  const items = Object.entries(s.byStatus).sort((a,b) => b[1] - a[1]);
  const chart = DASH_LAYOUT.charts['status'] || 'bar';
  return `
    <div class="card span-4">
      <div class="card-title">Status</div>
      ${renderCategoricalChart(items, k => STATUS_COLORS[k] || 'var(--ink3)', chart)}
    </div>`;
}

function dashSLA(s) {
  const chart = DASH_LAYOUT.charts['sla'] || 'tiles';
  const tilesBody = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:6px">
      <div class="r-tile" style="border-color:rgba(52,211,153,0.3);background:var(--green-lt);padding:10px"><div class="r-tile-n" style="color:var(--green);font-size:20px">${s.slaOk}</div><div class="r-tile-l" style="color:var(--green);font-size:10px">On track</div></div>
      <div class="r-tile" style="border-color:rgba(251,191,36,0.3);background:var(--amber-lt);padding:10px"><div class="r-tile-n" style="color:var(--amber);font-size:20px">${s.slaWarn}</div><div class="r-tile-l" style="color:var(--amber);font-size:10px">Warning</div></div>
      <div class="r-tile" style="border-color:rgba(248,113,113,0.3);background:var(--red-lt);padding:10px"><div class="r-tile-n" style="color:var(--red);font-size:20px">${s.slaBreach}</div><div class="r-tile-l" style="color:var(--red);font-size:10px">Breach</div></div>
    </div>`;
  const barBody = renderCategoricalChart(
    [['on track', s.slaOk], ['warning', s.slaWarn], ['breach', s.slaBreach]],
    k => k === 'on track' ? 'var(--green)' : k === 'warning' ? 'var(--amber)' : 'var(--red)',
    'bar'
  );
  return `
    <div class="card span-4">
      <div class="card-title">SLA health</div>
      ${chart === 'bar' ? barBody : tilesBody}
      <div style="margin-top:12px;font-size:11px;color:var(--ink3)"><strong style="color:var(--ink2)">${s.slaCompliance}%</strong> compliance window</div>
    </div>`;
}

function dashAgentLoad() {
  const agents = AGENTS.filter(a => a.active).map(a => ({
    ...a,
    open: TICKETS.filter(t => t.agent === a.name && (t.status === 'open' || t.status === 'escalated')).length
  })).sort((a, b) => b.open - a.open).slice(0, 5);
  if (!agents.length) return '<div class="card span-4"><div class="card-title">Agent load</div><div style="color:var(--ink3);font-size:12px">No active agents</div></div>';
  const max = Math.max(...agents.map(a => a.open), 1);
  const rows = agents.map(a => {
    const pct = (a.open / max) * 100;
    return `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px;cursor:pointer" onclick="openAgentFromDash('${escAttr(a.name)}')">
        <div style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:#fff;flex-shrink:0">${a.initials}</div>
        <div style="font-size:12px;color:var(--ink2);width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${a.name}</div>
        <div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden"><div style="background:var(--purple);height:100%;width:${pct}%"></div></div>
        <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);width:24px;text-align:right">${a.open}</div>
      </div>`;
  }).join('');
  return `
    <div class="card span-4">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="card-title" style="margin:0">Top open load</div>
        <span class="link" onclick="navTo('agents')" style="font-size:11px">All →</span>
      </div>
      ${rows}
    </div>`;
}

function dashAITags() {
  const count = TICKETS.reduce((sum, t) => sum + (t.aiTags || []).filter(at => !at.accepted).length, 0);
  const tickets = TICKETS.filter(t => (t.aiTags || []).some(at => !at.accepted)).length;
  return `
    <div class="card span-4">
      <div class="card-title">AI tag suggestions</div>
      <div style="text-align:center;padding:14px 0">
        <div style="font-size:36px;font-weight:700;color:${count>0?'var(--purple)':'var(--ink3)'};font-family:'Inter',sans-serif;letter-spacing:-.02em;line-height:1">${count}</div>
        <div style="font-size:11px;color:var(--ink3);margin-top:6px;text-transform:uppercase;letter-spacing:.06em;font-weight:500">Pending review</div>
      </div>
      <div style="font-size:11px;color:var(--ink3);text-align:center;line-height:1.5">${count > 0 ? `Across ${tickets} ticket${tickets===1?'':'s'} — open a ticket to accept or dismiss.` : 'All current AI suggestions have been reviewed.'}</div>
    </div>`;
}

function dashWorkflows() {
  const active = WORKFLOWS.filter(w => w.status === 'active').length;
  const runs = WORKFLOWS.reduce((s, w) => s + (w.runCount || 0), 0);
  const recentlyRun = WORKFLOWS.filter(w => w.lastRun).slice(0, 2);
  return `
    <div class="card span-4">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="card-title" style="margin:0">Automation</div>
        <span class="link" onclick="navTo('workflows')" style="font-size:11px">All →</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
        <div class="r-tile" style="padding:12px"><div class="r-tile-n" style="color:var(--green);font-size:22px">${active}</div><div class="r-tile-l" style="color:var(--ink3);font-size:10px">Active</div></div>
        <div class="r-tile" style="padding:12px"><div class="r-tile-n" style="color:var(--purple);font-size:22px">${runs}</div><div class="r-tile-l" style="color:var(--ink3);font-size:10px">Runs (30d)</div></div>
      </div>
      ${recentlyRun.length ? `<div style="font-size:11px;color:var(--ink3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;font-weight:500">Recent</div>
        ${recentlyRun.map(w => `<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink2);padding:3px 0"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${w.name}</span><span style="font-family:'DM Mono',monospace;color:var(--ink3);flex-shrink:0;margin-left:8px">${w.lastRun}</span></div>`).join('')}` : ''}
    </div>`;
}

function dashKB() {
  const articles = [...KB_ARTICLES].sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 4);
  const rows = articles.map(a => `
    <div onclick="openKBFromDash('${escAttr(a.id)}')" style="padding:8px 10px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;margin-bottom:5px;background:var(--off2);transition:all .15s" onmouseover="this.style.borderColor='var(--purple)'" onmouseout="this.style.borderColor='var(--rule)'">
      <div style="font-size:10px;color:var(--purple);text-transform:uppercase;letter-spacing:.04em;font-weight:600;margin-bottom:2px">${a.category}</div>
      <div style="font-size:12px;color:var(--ink);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${a.title}</div>
    </div>`).join('');
  return `
    <div class="card span-4">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div class="card-title" style="margin:0">Knowledge base</div>
        <span class="link" onclick="navTo('kb')" style="font-size:11px">All →</span>
      </div>
      ${rows || '<div style="color:var(--ink3);font-size:12px">No articles</div>'}
    </div>`;
}

function dashToday() {
  const recent = t => /min ago|just now|h ago/.test(t.updated || '');
  const created  = TICKETS.filter(recent).length;
  const resolved = TICKETS.filter(t => t.status === 'resolved' && recent(t)).length;
  const replies = TICKETS.reduce((s, t) => s + (t.msgs || []).filter(m => m.r === 'agent' || m.r === 'note').length, 0);
  return `
    <div class="card span-4">
      <div class="card-title">Today</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px">
        <div class="r-tile" style="padding:10px;border-color:rgba(34,211,238,0.3);background:var(--cyan-lt)"><div class="r-tile-n" style="color:var(--cyan);font-size:20px">${created}</div><div class="r-tile-l" style="color:var(--cyan);font-size:9px">Touched</div></div>
        <div class="r-tile" style="padding:10px;border-color:rgba(52,211,153,0.3);background:var(--green-lt)"><div class="r-tile-n" style="color:var(--green);font-size:20px">${resolved}</div><div class="r-tile-l" style="color:var(--green);font-size:9px">Resolved</div></div>
        <div class="r-tile" style="padding:10px;border-color:rgba(139,92,246,0.3);background:var(--purple-lt)"><div class="r-tile-n" style="color:var(--purple);font-size:20px">${replies}</div><div class="r-tile-l" style="color:var(--purple);font-size:9px">Replies</div></div>
      </div>
      <div style="margin-top:10px;font-size:11px;color:var(--ink3);line-height:1.5">Activity in the last 24 hours.</div>
    </div>`;
}

function dashPriority(s) {
  const items = ['urgent','high','normal','low'].filter(p => s.byPriority[p]).map(p => [p, s.byPriority[p]]);
  const chart = DASH_LAYOUT.charts['priority'] || 'bar';
  // The default "bar" rendering for priority uses per-row gauges (different
  // shape from the stacked horizontal bar). Keep it for parity with the
  // existing UI; donut + list reuse the shared chart helper.
  if (chart === 'bar') {
    const max = Math.max(...items.map(i => i[1]), 1);
    const rows = items.map(([k, v]) => {
      const pct = (v / max) * 100;
      return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
        <div style="font-size:12px;color:var(--ink2);width:60px;text-transform:capitalize">${escHtml(k)}</div>
        <div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden"><div style="background:${PRIORITY_COLORS[k]};height:100%;width:${pct}%"></div></div>
        <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);width:24px;text-align:right">${v}</div>
      </div>`;
    }).join('');
    return `
      <div class="card span-4">
        <div class="card-title">Priority</div>
        ${rows || '<div style="color:var(--ink3);font-size:12px">No tickets</div>'}
      </div>`;
  }
  return `
    <div class="card span-4">
      <div class="card-title">Priority</div>
      ${renderCategoricalChart(items, k => PRIORITY_COLORS[k] || 'var(--ink3)', chart)}
    </div>`;
}

function dashVolumeTrend() {
  // Build a 7-day deterministic series anchored on the latest ticket date in the seed
  const dates = TICKETS.map(t => new Date(t.created)).filter(d => !isNaN(d)).sort((a, b) => b - a);
  const today = dates[0] || new Date();
  const dowSeed = [4, 7, 9, 8, 6, 3, 2]; // Sun..Sat baseline volume
  const points = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const real = TICKETS.filter(t => t.created === iso).length;
    points.push({
      label: d.toLocaleDateString('en-US', { weekday: 'short' }),
      count: real + dowSeed[d.getDay()],
    });
  }
  const max = Math.max(...points.map(p => p.count), 1);
  const total = points.reduce((a, p) => a + p.count, 0);
  const w = 480, h = 90, padX = 12, padY = 8;
  const stepX = (w - padX * 2) / (points.length - 1);
  const yOf = c => h - padY - (c / max) * (h - padY * 2);
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${padX + i * stepX},${yOf(p.count)}`).join(' ');
  const areaPath = `${linePath} L ${padX + (points.length - 1) * stepX},${h - padY} L ${padX},${h - padY} Z`;
  return `
    <div class="card span-8">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px">
        <div class="card-title" style="margin:0">Ticket volume · last 7 days</div>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3)">${total} touches</span>
      </div>
      <svg width="100%" height="110" viewBox="0 0 ${w} ${h + 18}" preserveAspectRatio="none" style="display:block">
        <path d="${areaPath}" fill="var(--purple)" fill-opacity=".15"/>
        <path d="${linePath}" fill="none" stroke="var(--purple)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        ${points.map((p, i) => `<circle cx="${padX + i * stepX}" cy="${yOf(p.count)}" r="2.5" fill="var(--purple)"/>`).join('')}
        ${points.map((p, i) => `<text x="${padX + i * stepX}" y="${h + 14}" text-anchor="middle" font-family="'DM Mono', monospace" font-size="9" fill="var(--ink3)">${p.label}</text>`).join('')}
      </svg>
    </div>`;
}

function dashTopCustomers() {
  const counts = {};
  TICKETS.forEach(t => { counts[t.customerId] = (counts[t.customerId] || 0) + 1; });
  const top = Object.entries(counts)
    .map(([id, c]) => ({ cust: CUSTOMERS.find(x => x.id === id), count: c }))
    .filter(x => x.cust)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  if (!top.length) return '<div class="card span-4"><div class="card-title">Top customers</div><div style="color:var(--ink3);font-size:12px">No data</div></div>';
  const max = top[0].count;
  const rows = top.map(({ cust, count }) => {
    const pct = (count / max) * 100;
    return `<div onclick="CUSTOMER_SELECTED='${escAttr(cust.id)}';navTo('customers')" style="display:flex;align-items:center;gap:8px;margin-bottom:7px;cursor:pointer">
      <div style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:#fff;flex-shrink:0">${cust.first[0]}${cust.last[0]}</div>
      <div style="font-size:12px;color:var(--ink2);width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${cust.first} ${cust.last}</div>
      <div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden"><div style="background:var(--cyan);height:100%;width:${pct}%"></div></div>
      <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);width:24px;text-align:right">${count}</div>
    </div>`;
  }).join('');
  return `
    <div class="card span-4">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="card-title" style="margin:0">Top customers</div>
        <span class="link" onclick="navTo('customers')" style="font-size:11px">All →</span>
      </div>
      ${rows}
    </div>`;
}

function dashPersonal() {
  if (!SESSION) return '';
  const my = TICKETS.filter(t => t.agent === SESSION.name);
  const open = my.filter(t => t.status === 'open' || t.status === 'escalated').length;
  const csatRated = my.filter(t => t.csat);
  const avgCSAT = csatRated.length ? csatRated.reduce((a, t) => a + t.csat, 0) / csatRated.length : 0;
  const ranks = AGENTS.filter(a => a.active).map(a => ({
    name: a.name,
    open: TICKETS.filter(t => t.agent === a.name && (t.status === 'open' || t.status === 'escalated')).length,
  })).sort((a, b) => b.open - a.open);
  const myRank = ranks.findIndex(r => r.name === SESSION.name) + 1;
  return `
    <div class="card span-4" onclick="navTo('profile')" style="cursor:pointer">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="card-title" style="margin:0">Your stats</div>
        <span class="link" style="font-size:11px">Profile →</span>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <div style="width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:#fff;flex-shrink:0">${SESSION.initials}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${SESSION.name}</div>
          <div style="font-size:11px;color:var(--ink3)">${SESSION.role}</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:14px;text-align:center">
        <div><div style="font-size:18px;font-weight:700;color:var(--cyan);font-family:'Inter',sans-serif;line-height:1">${open}</div><div style="font-size:9px;color:var(--ink3);text-transform:uppercase;letter-spacing:.06em;font-weight:500;margin-top:4px">Open</div></div>
        <div><div style="font-size:18px;font-weight:700;color:var(--amber);font-family:'Inter',sans-serif;line-height:1">${csatRated.length?avgCSAT.toFixed(1):'—'}</div><div style="font-size:9px;color:var(--ink3);text-transform:uppercase;letter-spacing:.06em;font-weight:500;margin-top:4px">CSAT</div></div>
        <div><div style="font-size:18px;font-weight:700;color:var(--purple);font-family:'Inter',sans-serif;line-height:1">${myRank?'#'+myRank:'—'}</div><div style="font-size:9px;color:var(--ink3);text-transform:uppercase;letter-spacing:.06em;font-weight:500;margin-top:4px">Rank</div></div>
      </div>
    </div>`;
}

function dashCSAT(s) {
  const score = s.avgCSAT;
  const color = score >= 4 ? 'var(--green)' : score >= 3 ? 'var(--amber)' : score > 0 ? 'var(--red)' : 'var(--ink3)';
  return `
    <div class="card span-4">
      <div class="card-title">Customer satisfaction</div>
      <div style="text-align:center;padding:14px 0">
        <div style="font-size:42px;font-weight:700;color:${color};font-family:'Inter',sans-serif;letter-spacing:-.02em;line-height:1">${score?score.toFixed(1):'—'}</div>
        <div style="font-size:11px;color:var(--ink3);margin-top:8px">${s.csatCount} of ${s.total} tickets rated</div>
      </div>
      <div style="margin-top:6px;font-size:11px;color:var(--ink3);text-align:center"><span class="link" onclick="navTo('reports')">View report →</span></div>
    </div>`;
}

// ─── Customisable widget shell (dashboard + reports) ───────────────────────
// Each widget on the dashboard or reports page is wrapped with a chrome that
// provides a drag handle, a "..." menu (hide + chart-type switcher where
// available), and an aria-friendly hide button. Layouts (order, hidden set,
// per-widget chart choice) persist in localStorage so each agent's
// customisations stick across reloads.
const DASH_WIDGETS = [
  { id:'today',       title:'Today',                 span:'span-12', render:s => dashToday() },
  { id:'recent',      title:'Recent tickets',        span:'span-8',  render:s => dashRecentTickets() },
  { id:'status',      title:'Status',                span:'span-4',  render:s => dashStatus(s),       charts:['bar','donut','list'] },
  { id:'priority',    title:'Priority',              span:'span-4',  render:s => dashPriority(s),     charts:['bar','donut','list'] },
  { id:'sla',         title:'SLA health',            span:'span-4',  render:s => dashSLA(s),          charts:['tiles','bar'] },
  { id:'volume',      title:'Volume trend',          span:'span-12', render:s => dashVolumeTrend() },
  { id:'csat',        title:'Customer satisfaction', span:'span-4',  render:s => dashCSAT(s) },
  { id:'agent-load',  title:'Agent load',            span:'span-8',  render:s => dashAgentLoad() },
  { id:'personal',    title:'My queue',              span:'span-4',  render:s => dashPersonal() },
  { id:'ai-tags',     title:'AI tag suggestions',    span:'span-4',  render:s => dashAITags() },
  { id:'workflows',   title:'Workflows',             span:'span-4',  render:s => dashWorkflows() },
  { id:'kb',          title:'Knowledge base',        span:'span-4',  render:s => dashKB() },
  { id:'top-customers', title:'Top customers',       span:'span-8',  render:s => dashTopCustomers() },
];
const REPORT_WIDGETS = [
  { id:'r-status',    title:'Status breakdown', render:s => reportStatus(s),   charts:['bar','donut'] },
  { id:'r-sla',       title:'SLA',              render:s => reportSLA(s),      charts:['tiles','bar'] },
  { id:'r-priority',  title:'Priority',         render:s => reportPriority(s), charts:['bar','donut'] },
  { id:'r-category',  title:'Category',         render:s => reportCategory(s), charts:['bar','donut'] },
  { id:'r-agents',    title:'Tickets per agent',render:s => reportAgents(s) },
  { id:'r-csat',      title:'CSAT',             render:s => reportCSAT(s) },
  { id:'r-time',      title:'Time logged',      render:s => reportTime(s) },
];

const DEFAULT_DASH_LAYOUT   = { order: DASH_WIDGETS.map(w => w.id), hidden: [], charts: {} };
const DEFAULT_REPORT_LAYOUT = { order: REPORT_WIDGETS.map(w => w.id), hidden: [], charts: {} };

function loadLayout(key, fallback) {
  // Always deep-clone the fallback so any mutation through the returned
  // object can't bleed into DEFAULT_*_LAYOUT (or affect a sibling page using
  // the same fallback).
  const cloneFallback = () => ({
    order:  [...fallback.order],
    hidden: [...fallback.hidden],
    charts: { ...fallback.charts },
  });
  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null');
    if (!raw || typeof raw !== 'object') return cloneFallback();
    return {
      order:  Array.isArray(raw.order)  ? raw.order  : [...fallback.order],
      hidden: Array.isArray(raw.hidden) ? raw.hidden : [...fallback.hidden],
      charts: (raw.charts && typeof raw.charts === 'object') ? raw.charts : { ...fallback.charts },
    };
  } catch (e) { return cloneFallback(); }
}
function saveLayout(key, layout) {
  // Quota errors (private mode / disk full) shouldn't crash the page. Log so
  // a developer can see it in console, but let the in-memory layout keep
  // working for the rest of the session.
  try { localStorage.setItem(key, JSON.stringify(layout)); }
  catch (e) { console.warn('[layout] persist failed', key, e); }
}

let DASH_LAYOUT   = loadLayout('dash_layout',   DEFAULT_DASH_LAYOUT);
let REPORT_LAYOUT = loadLayout('report_layout', DEFAULT_REPORT_LAYOUT);

// New widgets added in code releases need to land at the end of the order so
// they're discoverable without nuking the agent's existing arrangement.
function reconcileLayout(layout, widgets) {
  const ids = widgets.map(w => w.id);
  layout.order = layout.order.filter(id => ids.includes(id));
  ids.forEach(id => { if (!layout.order.includes(id)) layout.order.push(id); });
  layout.hidden = layout.hidden.filter(id => ids.includes(id));
  return layout;
}
reconcileLayout(DASH_LAYOUT,   DASH_WIDGETS);
reconcileLayout(REPORT_LAYOUT, REPORT_WIDGETS);

function widgetChrome(scope, w, innerHtml, chartType) {
  // Strip the outer .card wrapper from each widget's existing render so we
  // can put our chrome around it. Widget render functions historically wrap
  // their body in `<div class="card ...">...</div>`; we extract the inner
  // content so the chrome can include a drag handle + menu.
  const m = innerHtml.match(/^\s*<div class="card([^"]*)"([^>]*)>([\s\S]*)<\/div>\s*$/);
  let spanClass = '';
  let body = innerHtml;
  if (m) {
    spanClass = (m[1] || '').trim();
    body = m[3];
    // Strip the widget's own "card-title" so the chrome shows the title.
    body = body.replace(/^\s*<div class="card-title"[^>]*>[\s\S]*?<\/div>\s*/, '');
  } else if (w.span) {
    spanClass = w.span;
  }
  // scope and widget id flow into inline onclick attributes; escAttr neutralises
  // single quotes so a malicious id can't close the JS string and inject code.
  // Today every id is machine-generated, but defense-in-depth keeps the layout
  // engine safe against future widgets sourced from user input.
  const sid = escAttr(scope);
  const wid = escAttr(w.id);
  const chartMenu = (w.charts && w.charts.length > 1) ? `<button title="Chart type" onclick="event.stopPropagation();showWidgetMenu(this,'${sid}','${wid}','chart')">📊</button>` : '';
  return `
    <div class="widget card ${escAttr(spanClass)}" data-widget-scope="${sid}" data-widget-id="${wid}" draggable="true"
         ondragstart="widgetDragStart(event,'${sid}','${wid}')"
         ondragend="widgetDragEnd(event)"
         ondragover="widgetDragOver(event,'${sid}','${wid}')"
         ondragleave="widgetDragLeave(event)"
         ondrop="widgetDragDrop(event,'${sid}','${wid}')">
      <div class="widget-head" title="Drag to reorder">
        <span class="widget-handle">⋮⋮</span>
        <span class="widget-title">${escHtml(w.title)}${chartType ? ` · <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--ink3);font-style:italic">${escHtml(chartType)}</span>` : ''}</span>
        <div class="widget-actions">
          ${chartMenu}
          <button title="Hide widget" onclick="event.stopPropagation();hideWidgetById('${sid}','${wid}')">×</button>
        </div>
      </div>
      <div class="widget-body">${body}</div>
    </div>`;
}

function renderWidgetGrid(scope, gridClass, widgets, layout, stats) {
  const byId = Object.fromEntries(widgets.map(w => [w.id, w]));
  const items = layout.order
    .filter(id => !layout.hidden.includes(id))
    .map(id => byId[id])
    .filter(Boolean);
  const hiddenN = layout.hidden.length;
  const cards = items.map(w => widgetChrome(scope, w, w.render(stats), layout.charts[w.id])).join('');
  return `
    <div class="${gridClass}" data-widget-scope="${scope}">${cards}</div>
    <div style="margin-top:14px;display:flex;justify-content:flex-end">
      <button class="btn btn-sm" onclick="showManageWidgetsModal('${scope}')">⚙ Manage widgets${hiddenN ? ` · ${hiddenN} hidden` : ''}</button>
    </div>`;
}

let _widgetDragging = null;
function widgetDragStart(ev, scope, id) {
  _widgetDragging = { scope, id };
  ev.target.classList.add('dragging');
  ev.dataTransfer.effectAllowed = 'move';
  // Some browsers require setData() to actually start a drag.
  try { ev.dataTransfer.setData('text/plain', id); } catch(e) {}
}
function widgetDragEnd(ev) {
  ev.target.classList.remove('dragging');
  document.querySelectorAll('.widget.drop-target-before,.widget.drop-target-after').forEach(el => {
    el.classList.remove('drop-target-before','drop-target-after');
  });
  _widgetDragging = null;
}
function widgetDragOver(ev, scope, id) {
  if (!_widgetDragging || _widgetDragging.scope !== scope) return;
  if (_widgetDragging.id === id) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  const target = ev.currentTarget;
  const rect = target.getBoundingClientRect();
  const before = (ev.clientX - rect.left) < rect.width / 2;
  target.classList.toggle('drop-target-before', before);
  target.classList.toggle('drop-target-after', !before);
}
function widgetDragLeave(ev) {
  ev.currentTarget.classList.remove('drop-target-before','drop-target-after');
}
function widgetDragDrop(ev, scope, targetId) {
  if (!_widgetDragging || _widgetDragging.scope !== scope) return;
  ev.preventDefault();
  const target = ev.currentTarget;
  const rect = target.getBoundingClientRect();
  const before = (ev.clientX - rect.left) < rect.width / 2;
  target.classList.remove('drop-target-before','drop-target-after');
  reorderWidget(scope, _widgetDragging.id, targetId, before);
}

function reorderWidget(scope, srcId, targetId, before) {
  const layout = scope === 'dash' ? DASH_LAYOUT : REPORT_LAYOUT;
  const i = layout.order.indexOf(srcId);
  if (i < 0) return;
  layout.order.splice(i, 1);
  let j = layout.order.indexOf(targetId);
  if (j < 0) j = layout.order.length;
  if (!before) j += 1;
  layout.order.splice(j, 0, srcId);
  saveLayout(scope === 'dash' ? 'dash_layout' : 'report_layout', layout);
  renderPage(scope === 'dash' ? 'dashboard' : 'reports');
}

function hideWidgetById(scope, id) {
  const layout = scope === 'dash' ? DASH_LAYOUT : REPORT_LAYOUT;
  if (!layout.hidden.includes(id)) layout.hidden.push(id);
  saveLayout(scope === 'dash' ? 'dash_layout' : 'report_layout', layout);
  renderPage(scope === 'dash' ? 'dashboard' : 'reports');
}
function showWidgetById(scope, id) {
  const layout = scope === 'dash' ? DASH_LAYOUT : REPORT_LAYOUT;
  layout.hidden = layout.hidden.filter(x => x !== id);
  saveLayout(scope === 'dash' ? 'dash_layout' : 'report_layout', layout);
  renderPage(scope === 'dash' ? 'dashboard' : 'reports');
}
function setWidgetChart(scope, id, chartType) {
  const layout = scope === 'dash' ? DASH_LAYOUT : REPORT_LAYOUT;
  layout.charts = layout.charts || {};
  layout.charts[id] = chartType;
  saveLayout(scope === 'dash' ? 'dash_layout' : 'report_layout', layout);
  document.querySelectorAll('.widget-menu').forEach(el => el.remove());
  renderPage(scope === 'dash' ? 'dashboard' : 'reports');
}
function resetWidgetLayout(scope) {
  const isDash = scope === 'dash';
  const src = isDash ? DEFAULT_DASH_LAYOUT : DEFAULT_REPORT_LAYOUT;
  const layout = { order: [...src.order], hidden: [...src.hidden], charts: { ...src.charts } };
  if (isDash) DASH_LAYOUT = layout; else REPORT_LAYOUT = layout;
  saveLayout(isDash ? 'dash_layout' : 'report_layout', layout);
  closeModal();
  renderPage(isDash ? 'dashboard' : 'reports');
}

function showWidgetMenu(anchor, scope, id, kind) {
  document.querySelectorAll('.widget-menu').forEach(el => el.remove());
  const widgets = scope === 'dash' ? DASH_WIDGETS : REPORT_WIDGETS;
  const layout  = scope === 'dash' ? DASH_LAYOUT : REPORT_LAYOUT;
  const w = widgets.find(x => x.id === id);
  if (!w || kind !== 'chart' || !w.charts) return;
  const current = layout.charts[id] || w.charts[0];
  const menu = document.createElement('div');
  menu.className = 'widget-menu';
  menu.innerHTML = `
    <div class="widget-menu-head">Chart type</div>
    ${w.charts.map(c => `<div class="widget-menu-item ${c===current?'active':''}" onclick="setWidgetChart('${scope}','${id}','${c}')">${c === current ? '✓' : '·'} ${escHtml(c)}</div>`).join('')}`;
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(8, r.right - 160)}px`;
  // Dismiss on outside click
  setTimeout(() => {
    const close = e => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', close); } };
    document.addEventListener('mousedown', close);
  }, 0);
}

function showManageWidgetsModal(scope) {
  const widgets = scope === 'dash' ? DASH_WIDGETS : REPORT_WIDGETS;
  const layout  = scope === 'dash' ? DASH_LAYOUT : REPORT_LAYOUT;
  const body = widgets.map(w => {
    const visible = !layout.hidden.includes(w.id);
    return `
      <div class="settings-row">
        <div>
          <div style="font-size:13px;font-weight:500;color:var(--ink)">${escHtml(w.title)}</div>
          <div style="font-size:11px;color:var(--ink3);margin-top:2px;font-family:'DM Mono',monospace">${escHtml(w.id)}</div>
        </div>
        <label class="toggle">
          <input type="checkbox" ${visible?'checked':''} onchange="this.checked ? showWidgetById('${scope}','${w.id}') : hideWidgetById('${scope}','${w.id}')">
          <span class="toggle-slider"></span>
        </label>
      </div>`;
  }).join('');
  showModal(scope === 'dash' ? 'Manage dashboard widgets' : 'Manage report widgets', `
    <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">Toggle a widget off to remove it from the layout. Drag the widget headers on the page to rearrange. Order and visibility are saved per browser.</div>
    ${body}
    <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--rule);text-align:right">
      <button class="btn btn-sm btn-danger" onclick="resetWidgetLayout('${scope}')">Reset to default</button>
    </div>
  `, null, null);
}

function renderDashboard() {
  const stats = computeReportStats(TICKETS);
  const open = TICKETS.filter(t => t.status === 'open' || t.status === 'escalated').length;
  const pending = TICKETS.filter(t => t.status === 'pending').length;
  const gdpr = TICKETS.filter(t => t.status === 'gdpr').length;
  const breach = TICKETS.filter(t => t.sla === 'breach').length;
  const warn = TICKETS.filter(t => t.sla === 'warn').length;
  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  })();
  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">${greeting}${SESSION?.name?', '+SESSION.name.split(' ')[0]:''}</div>
      </div>
      <div class="kpi-bar" style="grid-template-columns:repeat(6,1fr)">
        <div class="kpi"><div class="kpi-n c-blue">${open}</div><div class="kpi-l">Open</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${pending}</div><div class="kpi-l">Pending</div></div>
        <div class="kpi"><div class="kpi-n c-purple">${gdpr}</div><div class="kpi-l">GDPR</div></div>
        <div class="kpi"><div class="kpi-n c-red">${breach}</div><div class="kpi-l">SLA breach</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${warn}</div><div class="kpi-l">SLA warn</div></div>
        <div class="kpi"><div class="kpi-n c-green">${stats.resolved}</div><div class="kpi-l">Resolved</div></div>
      </div>
      <div class="page-scroll">
        ${renderWidgetGrid('dash', 'dash-grid-12', DASH_WIDGETS, DASH_LAYOUT, stats)}
      </div>
    </div>`;
}

// ─── Profile page ────────────────────────────────────────────────────────────
function renderProfile() {
  if (!SESSION) return '';
  const myTickets = TICKETS.filter(t => t.agent === SESSION.name);
  const open      = myTickets.filter(t => t.status === 'open' || t.status === 'escalated');
  const resolved  = myTickets.filter(t => t.status === 'resolved');
  const csatRated = myTickets.filter(t => t.csat);
  const avgCSAT   = csatRated.length ? csatRated.reduce((a, t) => a + t.csat, 0) / csatRated.length : 0;

  // Synthesised account fields (SESSION only carries role/name/initials in the demo)
  const email = SESSION.email || (SESSION.name.toLowerCase().replace(/\s+/g, '.') + '@maestrodesk.com');
  const since = SESSION.since || '2024-09-01';

  // Recent activity = last few messages this agent posted
  const myMessages = [];
  TICKETS.forEach(t => (t.msgs || []).forEach(m => {
    if (m.from === SESSION.name) myMessages.push({ ticketId: t.id, subject: t.subject, msg: m });
  }));
  const recent = myMessages.slice(-8).reverse();

  const openRows = open.slice(0, 5).map(t => `
    <div onclick="openTicket('${escAttr(t.id)}')" style="padding:9px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;display:flex;gap:10px;align-items:center;background:var(--off2);margin-bottom:6px;transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
      <span class="tag tag-${t.status}" style="font-size:9px">${t.status}</span>
      <span class="tag tag-${t.priority}" style="font-size:9px">${t.priority}</span>
      <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);flex-shrink:0">${t.id}</span>
      <span style="flex:1;font-size:12px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.subject}</span>
      <span class="sla-${t.sla}" style="font-size:10px;text-transform:uppercase;font-weight:500;flex-shrink:0">${t.sla}</span>
    </div>`).join('');

  const recentRows = recent.slice(0, 6).map(r => `
    <div onclick="openTicket('${escAttr(r.ticketId)}')" style="padding:8px 4px;border-bottom:1px solid var(--rule);cursor:pointer;font-size:12px;transition:background .1s" onmouseover="this.style.background='var(--off2)'" onmouseout="this.style.background='transparent'">
      <div style="display:flex;gap:8px;align-items:baseline;margin-bottom:3px">
        <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${r.ticketId}</span>
        ${r.msg.r === 'note'
          ? '<span class="note-mark">Note</span>'
          : '<span style="font-size:9px;color:var(--purple);text-transform:uppercase;letter-spacing:.06em;font-weight:600">Reply</span>'}
        <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink4);margin-left:auto">${r.msg.ts}</span>
      </div>
      <div style="color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.msg.t}</div>
    </div>`).join('');

  return `
    <div class="page">
      <div class="topbar"><div class="tb-title">My profile</div></div>
      <div class="page-scroll">
        <div class="card" style="display:flex;gap:18px;align-items:center;padding:24px">
          <div style="width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-weight:600;color:#fff;font-size:22px;flex-shrink:0">${SESSION.initials}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:22px;font-weight:700;color:var(--ink);letter-spacing:-.02em;line-height:1.1">${SESSION.name}</div>
            <div style="font-size:13px;color:var(--ink2);margin-top:8px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
              <span class="tag tag-resolved">${SESSION.role}</span>
              <span style="font-family:'DM Mono',monospace;color:var(--ink3)">${email}</span>
            </div>
            <div style="font-size:11px;color:var(--ink3);margin-top:6px">Member since ${since}</div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button class="btn btn-sm" onclick="showAgentOOOModal('${escAttr(SESSION.name)}')">${isAgentOOO(SESSION.name) ? 'Edit OOO' : 'Set OOO'}</button>
            <button class="btn btn-sm" onclick="SETTINGS_TAB='profile';navTo('settings')">Edit profile</button>
          </div>
        </div>
        ${isAgentOOO(SESSION.name) ? (() => {
          const me = AGENTS.find(a => a.name === SESSION.name);
          // If a note is present, the dates go on the right; with no note,
          // the dates are the only content so we don't double-render them.
          const dates = `${escHtml(me?.oooFrom || '')}${me?.oooTo ? ' → ' + escHtml(me.oooTo) : ''}`;
          return `<div style="margin-top:12px;padding:12px 16px;background:var(--amber-lt);border:1px solid var(--amber);border-radius:var(--r);font-size:12px;color:var(--amber);display:flex;gap:10px;align-items:center">
            <span style="font-weight:600;text-transform:uppercase;letter-spacing:.06em;font-size:11px">Out of office</span>
            ${me?.oooNote ? `<span style="color:var(--ink2);font-style:italic">${escHtml(me.oooNote)}</span>` : ''}
            <span style="margin-left:auto;font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${dates}</span>
          </div>`;
        })() : ''}

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:16px">
          <div class="r-tile" style="border-color:rgba(34,211,238,0.3);background:var(--cyan-lt)"><div class="r-tile-n" style="color:var(--cyan)">${open.length}</div><div class="r-tile-l" style="color:var(--cyan)">Open</div></div>
          <div class="r-tile" style="border-color:rgba(52,211,153,0.3);background:var(--green-lt)"><div class="r-tile-n" style="color:var(--green)">${resolved.length}</div><div class="r-tile-l" style="color:var(--green)">Resolved</div></div>
          <div class="r-tile" style="border-color:rgba(251,191,36,0.3);background:var(--amber-lt)"><div class="r-tile-n" style="color:var(--amber)">${csatRated.length?avgCSAT.toFixed(1):'—'}</div><div class="r-tile-l" style="color:var(--amber)">Avg CSAT (${csatRated.length})</div></div>
          <div class="r-tile"><div class="r-tile-n" style="color:var(--ink)">${myTickets.length}</div><div class="r-tile-l" style="color:var(--ink3)">Total assigned</div></div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px">
          <div class="card">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
              <div class="card-title" style="margin:0">Open tickets</div>
              ${open.length ? `<span class="link" onclick="setTicketView('mine');navTo('tickets')" style="font-size:11px">All →</span>` : ''}
            </div>
            ${open.length ? openRows : '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:18px 0">No open tickets — nice work.</div>'}
          </div>
          <div class="card">
            <div class="card-title">Recent activity</div>
            ${recent.length ? recentRows : '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:18px 0">No recent activity.</div>'}
          </div>
        </div>

        <div class="card" style="margin-top:16px">
          <div class="card-title">Account</div>
          <div class="ts-row"><span class="ts-key">Display name</span><span class="ts-val">${SESSION.name}</span></div>
          <div class="ts-row"><span class="ts-key">Initials</span><span class="ts-val">${SESSION.initials}</span></div>
          <div class="ts-row"><span class="ts-key">Role</span><span class="ts-val">${SESSION.role}</span></div>
          <div class="ts-row"><span class="ts-key">Email</span><span class="ts-val">${email}</span></div>
          <div class="ts-row"><span class="ts-key">Member since</span><span class="ts-val">${since}</span></div>
          <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
            <button class="btn" onclick="SETTINGS_TAB='profile';navTo('settings')">Edit profile</button>
            <button class="btn" onclick="SETTINGS_TAB='appearance';navTo('settings')">Appearance</button>
            <button class="btn" onclick="SETTINGS_TAB='notifications';navTo('settings')">Notifications</button>
            <button class="btn btn-danger" style="margin-left:auto" onclick="logout()">Sign out</button>
          </div>
        </div>
      </div>
    </div>`;
}

// ─── Reports ─────────────────────────────────────────────────────────────────
function setReportTF(v) { REPORT_TF = v; renderPage('reports'); }

function getReportTickets() {
  if (REPORT_TF === 'all') return TICKETS.slice();
  const days = REPORT_TF === '7d' ? 7 : REPORT_TF === '30d' ? 30 : 90;
  const dates = TICKETS.map(t => new Date(t.created)).filter(d => !isNaN(d)).sort((a,b) => b - a);
  const now = dates[0] || new Date();
  const cutoff = new Date(now); cutoff.setDate(now.getDate() - days);
  return TICKETS.filter(t => new Date(t.created) >= cutoff);
}

function computeReportStats(tickets) {
  const byStatus = {}, byPriority = {}, byCategory = {}, byAgent = {};
  const csatScores = [];
  const timeByAgent = {};
  let slaOk = 0, slaWarn = 0, slaBreach = 0;
  let timeTotal = 0, timeBillable = 0;
  for (const t of tickets) {
    byStatus[t.status]     = (byStatus[t.status]     ||0) + 1;
    byPriority[t.priority] = (byPriority[t.priority] ||0) + 1;
    byCategory[t.category] = (byCategory[t.category] ||0) + 1;
    byAgent[t.agent]       = (byAgent[t.agent]       ||0) + 1;
    if (t.csat) csatScores.push(t.csat);
    if      (t.sla === 'ok')     slaOk++;
    else if (t.sla === 'warn')   slaWarn++;
    else if (t.sla === 'breach') slaBreach++;
    (t.timeEntries || []).forEach(e => {
      timeTotal += e.minutes || 0;
      if (e.billable !== false) timeBillable += e.minutes || 0;
      if (!timeByAgent[e.agent]) timeByAgent[e.agent] = { total: 0, billable: 0 };
      timeByAgent[e.agent].total += e.minutes || 0;
      if (e.billable !== false) timeByAgent[e.agent].billable += e.minutes || 0;
    });
  }
  const total = tickets.length;
  const resolved = byStatus.resolved || 0;
  const resolutionRate = total ? Math.round(resolved/total*100) : 0;
  const avgCSAT = csatScores.length ? csatScores.reduce((a,b)=>a+b,0)/csatScores.length : 0;
  const slaCompliance = total ? Math.round((slaOk + slaWarn)/total*100) : 0;
  return { total, byStatus, byPriority, byCategory, byAgent, csatScores, csatCount:csatScores.length, avgCSAT, slaOk, slaWarn, slaBreach, slaCompliance, resolved, resolutionRate, timeTotal, timeBillable, timeByAgent };
}

const STATUS_COLORS   = { open:'var(--cyan)', pending:'var(--amber)', escalated:'var(--purple)', gdpr:'var(--red)', resolved:'var(--green)' };
const PRIORITY_COLORS = { urgent:'var(--red)', high:'var(--amber)', normal:'var(--cyan)', low:'var(--ink4)' };

function rBarRow(label, count, max, color) {
  const pct = max ? (count/max)*100 : 0;
  return `<div class="r-bar-row"><div class="r-bar-lbl">${label}</div><div class="r-bar-track"><div class="r-bar-fill" style="background:${color||'var(--purple)'};width:${pct}%"></div></div><div class="r-bar-val">${count}</div></div>`;
}

function reportStatus(s) {
  const items = Object.entries(s.byStatus).sort((a,b) => b[1] - a[1]);
  const chart = REPORT_LAYOUT.charts['r-status'] || 'bar';
  return `<div class="card"><div class="card-title">Status distribution</div>${renderCategoricalChart(items, k => STATUS_COLORS[k] || 'var(--ink3)', chart)}</div>`;
}

function reportPriority(s) {
  const items = ['urgent','high','normal','low'].filter(p => s.byPriority[p]).map(p => [p, s.byPriority[p]]);
  const chart = REPORT_LAYOUT.charts['r-priority'] || 'bar';
  return `<div class="card"><div class="card-title">Priority breakdown</div>${renderCategoricalChart(items, k => PRIORITY_COLORS[k] || 'var(--ink3)', chart)}</div>`;
}

function reportCategory(s) {
  const items = Object.entries(s.byCategory).sort((a,b) => b[1] - a[1]);
  const chart = REPORT_LAYOUT.charts['r-category'] || 'bar';
  return `<div class="card"><div class="card-title">Category volume</div>${renderCategoricalChart(items, () => 'var(--cyan)', chart)}</div>`;
}

function reportAgents(s) {
  const items = Object.entries(s.byAgent).sort((a,b) => b[1] - a[1]);
  const max = Math.max(...items.map(i => i[1]), 1);
  const rows = items.map(([name, count]) => rBarRow(name, count, max, 'var(--purple)')).join('');
  return `<div class="card"><div class="card-title">Tickets per agent</div>${rows || '<div style="color:var(--ink3);font-size:12px">No tickets in range</div>'}</div>`;
}

function reportCSAT(s) {
  const buckets = [1,2,3,4,5].map(n => s.csatScores.filter(x => x === n).length);
  const max = Math.max(...buckets, 1);
  const rows = buckets.map((c, i) => {
    const stars = '★'.repeat(i+1) + '☆'.repeat(4-i);
    const pct = (c/max)*100;
    return `<div class="r-bar-row"><div style="font-size:11px;color:var(--amber);width:60px;flex-shrink:0;letter-spacing:1px">${stars}</div><div class="r-bar-track"><div class="r-bar-fill" style="background:var(--amber);width:${pct}%"></div></div><div class="r-bar-val">${c}</div></div>`;
  }).reverse().join('');
  return `
    <div class="card">
      <div class="card-title">CSAT</div>
      <div style="display:flex;align-items:flex-end;gap:14px;margin:6px 0 14px">
        <div style="font-size:30px;font-weight:700;line-height:1;color:var(--amber);font-family:'Inter',sans-serif;letter-spacing:-.02em">${s.avgCSAT?s.avgCSAT.toFixed(1):'—'}</div>
        <div style="font-size:11px;color:var(--ink3);padding-bottom:4px">${s.csatCount} of ${s.total} tickets rated</div>
      </div>
      ${rows}
    </div>`;
}

function reportTime(s) {
  const items = Object.entries(s.timeByAgent || {}).sort((a, b) => b[1].total - a[1].total);
  const max = Math.max(...items.map(i => i[1].total), 1);
  const rows = items.map(([name, vals]) => {
    const pct = (vals.total / max) * 100;
    const billPct = vals.total ? (vals.billable / vals.total) * 100 : 0;
    return `<div class="r-bar-row">
      <div style="font-size:11px;color:var(--ink2);width:140px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(name || 'Unassigned')}</div>
      <div class="r-bar-track" title="${escHtml(fmtMinutes(vals.billable))} billable of ${escHtml(fmtMinutes(vals.total))}"><div class="r-bar-fill" style="background:var(--purple);width:${pct}%;position:relative"><div style="background:var(--amber);height:100%;width:${billPct}%"></div></div></div>
      <div class="r-bar-val" style="font-family:'DM Mono',monospace">${fmtMinutes(vals.total)}</div>
    </div>`;
  }).join('');
  const billPct = s.timeTotal ? Math.round((s.timeBillable / s.timeTotal) * 100) : 0;
  return `
    <div class="card">
      <div class="card-title">Time logged</div>
      <div style="display:flex;align-items:flex-end;gap:14px;margin:6px 0 14px">
        <div style="font-size:30px;font-weight:700;line-height:1;color:var(--purple);font-family:'Inter',sans-serif;letter-spacing:-.02em">${s.timeTotal ? fmtMinutes(s.timeTotal) : '—'}</div>
        <div style="font-size:11px;color:var(--ink3);padding-bottom:4px">${fmtMinutes(s.timeBillable)} billable · ${billPct}%</div>
      </div>
      ${rows || '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:16px 0">No time logged in this range</div>'}
    </div>`;
}

function reportSLA(s) {
  return `
    <div class="card">
      <div class="card-title">SLA</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:6px">
        <div class="r-tile" style="border-color:rgba(52,211,153,0.3);background:var(--green-lt)"><div class="r-tile-n" style="color:var(--green)">${s.slaOk}</div><div class="r-tile-l" style="color:var(--green)">On track</div></div>
        <div class="r-tile" style="border-color:rgba(251,191,36,0.3);background:var(--amber-lt)"><div class="r-tile-n" style="color:var(--amber)">${s.slaWarn}</div><div class="r-tile-l" style="color:var(--amber)">Warning</div></div>
        <div class="r-tile" style="border-color:rgba(248,113,113,0.3);background:var(--red-lt)"><div class="r-tile-n" style="color:var(--red)">${s.slaBreach}</div><div class="r-tile-l" style="color:var(--red)">Breached</div></div>
      </div>
      <div style="margin-top:14px;font-size:12px;color:var(--ink2);line-height:1.5"><strong style="color:var(--ink)">${s.slaCompliance}%</strong> of tickets are within SLA window</div>
    </div>`;
}

function exportReport() {
  const tickets = getReportTickets();
  const headers = ['ID','Subject','Status','Priority','Category','Agent','Created','Updated','SLA','CSAT','Time logged','Time billable'];
  const rows = tickets.map(t => [t.id, t.subject, t.status, t.priority, t.category, t.agent, t.created, t.updated, t.sla, t.csat ?? '', fmtMinutes(ticketTotalMinutes(t)), fmtMinutes(ticketBillableMinutes(t))]);
  const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `tickets-${REPORT_TF}-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function renderReports() {
  const tf = REPORT_TF;
  const tickets = getReportTickets();
  const s = computeReportStats(tickets);
  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Reports</div>
        <select class="filter-select" onchange="setReportTF(this.value)">
          <option value="7d"  ${tf==='7d'?'selected':''}>Last 7 days</option>
          <option value="30d" ${tf==='30d'?'selected':''}>Last 30 days</option>
          <option value="90d" ${tf==='90d'?'selected':''}>Last 90 days</option>
          <option value="all" ${tf==='all'?'selected':''}>All time</option>
        </select>
        <button class="btn btn-sm" onclick="exportReport()">Export CSV</button>
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${s.total}</div><div class="kpi-l">Total tickets</div></div>
        <div class="kpi"><div class="kpi-n c-green">${s.resolutionRate}%</div><div class="kpi-l">Resolved</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${s.avgCSAT?s.avgCSAT.toFixed(1):'—'}</div><div class="kpi-l">Avg CSAT</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${s.slaCompliance}%</div><div class="kpi-l">SLA compliance</div></div>
        <div class="kpi"><div class="kpi-n c-purple">${fmtMinutes(s.timeTotal)}</div><div class="kpi-l">Time logged</div></div>
      </div>
      <div class="page-scroll">
        ${renderWidgetGrid('report', 'report-grid', REPORT_WIDGETS, REPORT_LAYOUT, s)}
      </div>
    </div>`;
}

// ─── Agents ──────────────────────────────────────────────────────────────────
let AGENT_FILTER_ROLE = 'all';
let AGENT_FILTER_STATUS = 'all';
let AGENT_QUERY = '';

function getAgentStats(name) {
  const tickets = TICKETS.filter(t => t.agent === name);
  const open = tickets.filter(t => t.status === 'open' || t.status === 'escalated').length;
  const resolved = tickets.filter(t => t.status === 'resolved').length;
  const csat = tickets.filter(t => t.csat);
  const avgCSAT = csat.length ? csat.reduce((a, t) => a + t.csat, 0) / csat.length : 0;
  return { tickets, total: tickets.length, open, resolved, csatCount: csat.length, avgCSAT };
}

function renderAgents() {
  if (AGENT_SELECTED) return renderAgentDetail(AGENT_SELECTED);
  const admin = isAdmin();
  const allRoles = Object.keys(ROLES_MATRIX);

  let list = [...AGENTS];
  if (AGENT_FILTER_ROLE !== 'all')   list = list.filter(a => a.role === AGENT_FILTER_ROLE);
  if (AGENT_FILTER_STATUS === 'active')   list = list.filter(a => a.active);
  if (AGENT_FILTER_STATUS === 'inactive') list = list.filter(a => !a.active);
  if (AGENT_QUERY.trim()) {
    const q = AGENT_QUERY.toLowerCase();
    list = list.filter(a => a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q));
  }

  const total = AGENTS.length;
  const activeN = AGENTS.filter(a => a.active).length;
  const totalLoad = AGENTS.filter(a => a.active).reduce((sum, a) =>
    sum + TICKETS.filter(t => t.agent === a.name && (t.status === 'open' || t.status === 'escalated')).length, 0);
  const avgLoad = activeN ? (totalLoad / activeN).toFixed(1) : '0';

  let topAgent = null, topCSAT = 0;
  AGENTS.forEach(a => {
    const s = getAgentStats(a.name);
    if (s.csatCount > 0 && s.avgCSAT > topCSAT) { topCSAT = s.avgCSAT; topAgent = a; }
  });

  const cards = list.map(a => {
    const s = getAgentStats(a.name);
    const ooo = isAgentOOO(a.name);
    return `
      <div class="agent-card ${a.active?'':'inactive'}" onclick="openAgentDetail('${escAttr(a.name)}')">
        <div class="agent-card-head">
          <div class="agent-av">${a.initials}</div>
          <div style="flex:1;min-width:0">
            <div class="agent-name">${a.name}</div>
            <div class="agent-role">${a.role}</div>
          </div>
          ${ooo ? `<span class="tag" style="font-size:9px;flex-shrink:0;background:var(--amber-lt);color:var(--amber);border:1px solid var(--amber)" title="${escAttr(a.oooNote || ('Until ' + (a.oooTo || 'further notice')))}">OOO</span>` : `<span class="tag ${a.active?'tag-resolved':'tag-gdpr'}" style="font-size:9px;flex-shrink:0">${a.active?'Active':'Off'}</span>`}
        </div>
        ${ooo ? `<div style="font-size:11px;color:var(--amber);font-style:italic;line-height:1.4">${escHtml(a.oooNote || `On leave until ${a.oooTo || '—'}`)}</div>` : ''}
        <div class="agent-stats">
          <div class="agent-stat"><div class="agent-stat-n c-blue">${s.open}</div><div class="agent-stat-l">Open</div></div>
          <div class="agent-stat"><div class="agent-stat-n">${s.total}</div><div class="agent-stat-l">Total</div></div>
          <div class="agent-stat"><div class="agent-stat-n c-amber">${s.csatCount?s.avgCSAT.toFixed(1):'—'}</div><div class="agent-stat-l">CSAT</div></div>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Agents</div>
        ${admin
          ? `<button class="btn btn-solid btn-sm" onclick="agentNew()">+ Add Agent</button>`
          : `<span style="font-size:11px;color:var(--ink3);font-style:italic">Read-only — admin access required to edit</span>`}
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Total agents</div></div>
        <div class="kpi"><div class="kpi-n c-green">${activeN}</div><div class="kpi-l">Active</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${avgLoad}</div><div class="kpi-l">Avg open load</div></div>
        <div class="kpi"><div class="kpi-n c-amber" style="font-size:18px;line-height:1.1">${topAgent?topAgent.name:'—'}</div><div class="kpi-l">Top CSAT ${topAgent?'· '+topCSAT.toFixed(1):''}</div></div>
      </div>
      <div class="filter-bar">
        <span class="filter-label">Filter</span>
        <input class="filter-select" id="agent-search" placeholder="Search agents…" style="width:200px" value="${AGENT_QUERY}" oninput="agentSetQuery(this.value)"/>
        <select class="filter-select" onchange="agentSetRole(this.value)">
          <option value="all" ${AGENT_FILTER_ROLE==='all'?'selected':''}>All roles</option>
          ${allRoles.map(r => `<option value="${r}" ${AGENT_FILTER_ROLE===r?'selected':''}>${r}</option>`).join('')}
        </select>
        <select class="filter-select" onchange="agentSetStatus(this.value)">
          <option value="all"      ${AGENT_FILTER_STATUS==='all'?'selected':''}>All statuses</option>
          <option value="active"   ${AGENT_FILTER_STATUS==='active'?'selected':''}>Active</option>
          <option value="inactive" ${AGENT_FILTER_STATUS==='inactive'?'selected':''}>Inactive</option>
        </select>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${total}</span>
      </div>
      <div class="page-scroll">
        ${list.length
          ? `<div class="agent-grid">${cards}</div>`
          : `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No agents match</div><div class="empty-line"></div></div>`}
      </div>
    </div>`;
}

function getAgentDeepStats(name) {
  const tickets = TICKETS.filter(t => t.agent === name);
  const byStatus = {}, byPriority = {}, byCategory = {};
  tickets.forEach(t => {
    byStatus[t.status]     = (byStatus[t.status]     || 0) + 1;
    byPriority[t.priority] = (byPriority[t.priority] || 0) + 1;
    byCategory[t.category] = (byCategory[t.category] || 0) + 1;
  });
  const csatBuckets = [1,2,3,4,5].map(n => tickets.filter(t => t.csat === n).length);

  const custCounts = {};
  tickets.forEach(t => { custCounts[t.customerId] = (custCounts[t.customerId] || 0) + 1; });
  const topCustomers = Object.entries(custCounts)
    .map(([id, c]) => ({ cust: CUSTOMERS.find(x => x.id === id), count: c }))
    .filter(x => x.cust)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const tagCounts = {};
  tickets.forEach(t => (t.tags || []).forEach(tag => { tagCounts[tag] = (tagCounts[tag] || 0) + 1; }));
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);

  const responseTimes = [];
  tickets.forEach(t => {
    const msgs = t.msgs || [];
    const firstCust = msgs.find(m => m.r === 'customer');
    if (!firstCust) return;
    const firstAgent = msgs.find(m => (m.r === 'agent' || m.r === 'ai') && msgs.indexOf(m) > msgs.indexOf(firstCust));
    if (firstAgent && /^\d+:\d+/.test(firstCust.ts) && /^\d+:\d+/.test(firstAgent.ts)) {
      const [ch, cm] = firstCust.ts.split(':').map(Number);
      const [ah, am] = firstAgent.ts.split(':').map(Number);
      const diff = Math.max(0, (ah - ch) * 60 + (am - cm));
      responseTimes.push(diff);
    }
  });
  const avgResponseMin = responseTimes.length ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) : 0;

  const activity = [];
  TICKETS.forEach(t => (t.msgs || []).forEach(m => {
    if (m.from === name) activity.push({ ticketId: t.id, subject: t.subject, role: m.r, text: m.t, ts: m.ts });
  }));
  const recent = activity.slice(-8).reverse();

  const ranks = AGENTS.filter(a => a.active).map(a => ({
    name: a.name,
    open: TICKETS.filter(t => t.agent === a.name && (t.status === 'open' || t.status === 'escalated')).length,
  })).sort((a, b) => b.open - a.open);
  const rank = ranks.findIndex(r => r.name === name) + 1;
  const totalActive = ranks.length;

  const slaOk = tickets.filter(t => t.sla === 'ok').length;
  const slaWarn = tickets.filter(t => t.sla === 'warn').length;
  const slaBreach = tickets.filter(t => t.sla === 'breach').length;
  const slaCompliance = tickets.length ? Math.round((slaOk + slaWarn) / tickets.length * 100) : 0;

  return { byStatus, byPriority, byCategory, csatBuckets, topCustomers, topTags, avgResponseMin, recent, rank, totalActive, slaOk, slaWarn, slaBreach, slaCompliance };
}

function fmtMinutes(m) {
  if (!m) return '—';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${h}h${min ? ' ' + min + 'm' : ''}`;
}

function agentBarRow(label, count, max, color) {
  const pct = max ? (count / max) * 100 : 0;
  return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
    <div style="font-size:11px;color:var(--ink2);width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-transform:capitalize">${label}</div>
    <div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden"><div style="background:${color || 'var(--purple)'};height:100%;width:${pct}%"></div></div>
    <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);width:24px;text-align:right">${count}</div>
  </div>`;
}

function renderAgentDetail(name) {
  const a = AGENTS.find(x => x.name === name);
  if (!a) { AGENT_SELECTED = null; return renderAgents(); }
  const s = getAgentStats(name);
  const d = getAgentDeepStats(name);
  const admin = isAdmin();
  const allRoles = Object.keys(ROLES_MATRIX);

  const STATUS_C = { open:'var(--cyan)', pending:'var(--amber)', escalated:'var(--purple)', gdpr:'var(--red)', resolved:'var(--green)' };
  const PRIORITY_C = { urgent:'var(--red)', high:'var(--amber)', normal:'var(--cyan)', low:'var(--ink4)' };

  const statusItems = Object.entries(d.byStatus).sort((a, b) => b[1] - a[1]);
  const statusMax = Math.max(...statusItems.map(i => i[1]), 1);
  const statusBars = statusItems.map(([k, v]) => agentBarRow(k, v, statusMax, STATUS_C[k] || 'var(--purple)')).join('') || '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:6px 0">—</div>';

  const priItems = ['urgent','high','normal','low'].filter(p => d.byPriority[p]).map(p => [p, d.byPriority[p]]);
  const priMax = Math.max(...priItems.map(i => i[1]), 1);
  const priBars = priItems.map(([k, v]) => agentBarRow(k, v, priMax, PRIORITY_C[k])).join('') || '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:6px 0">—</div>';

  const catItems = Object.entries(d.byCategory).sort((a, b) => b[1] - a[1]);
  const catMax = Math.max(...catItems.map(i => i[1]), 1);
  const catBars = catItems.map(([k, v]) => agentBarRow(k, v, catMax, 'var(--cyan)')).join('') || '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:6px 0">—</div>';

  const csatMax = Math.max(...d.csatBuckets, 1);
  const csatRows = d.csatBuckets.map((c, i) => {
    const stars = '★'.repeat(i + 1) + '☆'.repeat(4 - i);
    const pct = (c / csatMax) * 100;
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <div style="font-size:11px;color:var(--amber);width:60px;flex-shrink:0;letter-spacing:1px">${stars}</div>
      <div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden"><div style="background:var(--amber);height:100%;width:${pct}%"></div></div>
      <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);width:24px;text-align:right">${c}</div>
    </div>`;
  }).reverse().join('');

  const topCustRows = d.topCustomers.length ? d.topCustomers.map(({ cust, count }) => {
    const pct = (count / d.topCustomers[0].count) * 100;
    return `<div onclick="CUSTOMER_SELECTED='${escAttr(cust.id)}';navTo('customers')" style="display:flex;align-items:center;gap:8px;margin-bottom:7px;cursor:pointer">
      <div style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:#fff;flex-shrink:0">${cust.first[0]}${cust.last[0]}</div>
      <div style="font-size:12px;color:var(--ink2);width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${cust.first} ${cust.last}</div>
      <div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden"><div style="background:var(--cyan);height:100%;width:${pct}%"></div></div>
      <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);width:22px;text-align:right">${count}</div>
    </div>`;
  }).join('') : '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:8px 0">No customers handled</div>';

  const tagsBlock = d.topTags.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:6px">${d.topTags.map(([tag, c]) => `<span class="tag tag-neutral" style="font-size:11px;display:inline-flex;align-items:center;gap:5px">${tag} <span style="color:var(--ink3);font-family:'DM Mono',monospace">${c}</span></span>`).join('')}</div>`
    : '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:8px 0">No tags used yet</div>';

  const recentRows = d.recent.length ? d.recent.map(r => `
    <div onclick="openTicket('${escAttr(r.ticketId)}')" style="padding:8px 4px;border-bottom:1px solid var(--rule);cursor:pointer;font-size:12px;transition:background .1s" onmouseover="this.style.background='var(--off2)'" onmouseout="this.style.background='transparent'">
      <div style="display:flex;gap:8px;align-items:baseline;margin-bottom:3px">
        <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${r.ticketId}</span>
        ${r.role === 'note' ? '<span class="note-mark">Note</span>' : '<span style="font-size:9px;color:var(--purple);text-transform:uppercase;letter-spacing:.06em;font-weight:600">Reply</span>'}
        <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink4);margin-left:auto">${r.ts}</span>
      </div>
      <div style="color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.text}</div>
    </div>`).join('') : '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:18px 0">No activity recorded</div>';

  const ticketRows = s.tickets.map(t => {
    const cust = CUSTOMERS.find(c => c.id === t.customerId);
    return `<tr onclick="openTicket('${escAttr(t.id)}')" style="cursor:pointer">
      <td class="bold">${t.id}</td>
      <td>${cust ? cust.first + ' ' + cust.last : '—'}</td>
      <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.subject}</td>
      <td><span class="tag tag-${t.status}">${t.status}</span></td>
      <td><span class="tag tag-${t.priority}">${t.priority}</span></td>
      <td><span class="sla-${t.sla}" style="font-size:11px;text-transform:uppercase;font-weight:500">${t.sla}</span></td>
      <td style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${t.updated}</td>
    </tr>`;
  }).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-breadcrumb">
          <span onclick="closeAgentDetail()">Agents</span>
          <span class="tb-sep">/</span>
          <span style="color:var(--ink);font-weight:500">${a.name}</span>
        </div>
      </div>
      <div class="page-scroll">
        <div style="display:flex;gap:14px;align-items:center;padding:8px 0 18px;border-bottom:1px solid var(--rule);margin-bottom:18px">
          <div style="width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-weight:600;color:#fff;font-size:16px;flex-shrink:0">${a.initials}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:18px;font-weight:600;color:var(--ink)">${a.name}</div>
            <div style="font-size:12px;color:var(--ink3);margin-top:2px">${a.role}${a.active && d.totalActive ? ` · Rank #${d.rank} of ${d.totalActive} by open load` : ''}</div>
          </div>
          ${isAgentOOO(a.name)
            ? `<span class="tag" style="background:var(--amber-lt);color:var(--amber);border:1px solid var(--amber)" title="${escAttr(a.oooNote || '')}">OOO${a.oooTo ? ' until ' + escHtml(a.oooTo) : ''}</span>`
            : `<span class="tag ${a.active?'tag-resolved':'tag-gdpr'}">${a.active?'Active':'Deactivated'}</span>`}
          ${admin || (SESSION && SESSION.name === a.name) ? `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            ${admin ? `<select class="filter-select" onchange="reassignAgent('${escAttr(a.name)}',this.value)" style="font-size:12px">
              ${allRoles.map(r => `<option value="${r}" ${a.role===r?'selected':''}>${r}</option>`).join('')}
            </select>` : ''}
            <button class="btn btn-sm" onclick="showAgentOOOModal('${escAttr(a.name)}')">${isAgentOOO(a.name) ? 'Edit OOO' : 'Set OOO'}</button>
            ${admin ? (a.active
              ? `<button class="btn btn-sm" onclick="setAgentActive('${escAttr(a.name)}',false)">Deactivate</button>`
              : `<button class="btn btn-sm" onclick="setAgentActive('${escAttr(a.name)}',true)">Activate</button>`) : ''}
            ${admin ? `<button class="btn btn-sm btn-danger" onclick="deleteAgentPrompt('${escAttr(a.name)}')">Delete</button>` : ''}
          </div>` : ''}
        </div>
        ${isAgentOOO(a.name) ? `<div style="margin:0 0 16px;padding:10px 14px;background:var(--amber-lt);border:1px solid var(--amber);border-radius:var(--r);font-size:12px;color:var(--amber);display:flex;gap:10px;align-items:center">
          <span style="font-weight:600;text-transform:uppercase;letter-spacing:.06em;font-size:11px">Out of office</span>
          ${a.oooNote ? `<span style="color:var(--ink2);font-style:italic">${escHtml(a.oooNote)}</span>` : ''}
          <span style="margin-left:auto;font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${escHtml(a.oooFrom)}${a.oooTo ? ' → ' + escHtml(a.oooTo) : ''}</span>
        </div>` : ''}

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
          <div class="r-tile" style="border-color:rgba(34,211,238,0.3);background:var(--cyan-lt)"><div class="r-tile-n" style="color:var(--cyan)">${s.open}</div><div class="r-tile-l" style="color:var(--cyan)">Open</div></div>
          <div class="r-tile"><div class="r-tile-n" style="color:var(--ink)">${s.total}</div><div class="r-tile-l" style="color:var(--ink3)">Total assigned</div></div>
          <div class="r-tile" style="border-color:rgba(52,211,153,0.3);background:var(--green-lt)"><div class="r-tile-n" style="color:var(--green)">${s.resolved}</div><div class="r-tile-l" style="color:var(--green)">Resolved</div></div>
          <div class="r-tile" style="border-color:rgba(251,191,36,0.3);background:var(--amber-lt)"><div class="r-tile-n" style="color:var(--amber)">${s.csatCount?s.avgCSAT.toFixed(1):'—'}</div><div class="r-tile-l" style="color:var(--amber)">CSAT (${s.csatCount})</div></div>
        </div>

        <div class="card" style="margin-bottom:16px">
          <div class="card-title">Performance</div>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:6px">
            <div><div style="font-family:'DM Mono',monospace;font-size:18px;font-weight:600;color:var(--ink);line-height:1">${a.active && d.totalActive ? '#'+d.rank : '—'}</div><div style="font-size:10px;color:var(--ink3);margin-top:4px;text-transform:uppercase;letter-spacing:.06em;font-weight:500">Rank by load</div></div>
            <div><div style="font-family:'DM Mono',monospace;font-size:18px;font-weight:600;color:var(--ink);line-height:1">${fmtMinutes(d.avgResponseMin)}</div><div style="font-size:10px;color:var(--ink3);margin-top:4px;text-transform:uppercase;letter-spacing:.06em;font-weight:500">Avg first response</div></div>
            <div><div style="font-family:'DM Mono',monospace;font-size:18px;font-weight:600;color:var(--ink);line-height:1">${s.total ? Math.round(s.resolved/s.total*100) + '%' : '—'}</div><div style="font-size:10px;color:var(--ink3);margin-top:4px;text-transform:uppercase;letter-spacing:.06em;font-weight:500">Resolution rate</div></div>
            <div><div style="font-family:'DM Mono',monospace;font-size:18px;font-weight:600;color:${d.slaCompliance>=80?'var(--green)':d.slaCompliance>=60?'var(--amber)':'var(--red)'};line-height:1">${s.total ? d.slaCompliance + '%' : '—'}</div><div style="font-size:10px;color:var(--ink3);margin-top:4px;text-transform:uppercase;letter-spacing:.06em;font-weight:500">SLA compliance</div></div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:16px">
          <div class="card"><div class="card-title">By status</div>${statusBars}</div>
          <div class="card"><div class="card-title">By priority</div>${priBars}</div>
          <div class="card"><div class="card-title">By category</div>${catBars}</div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
          <div class="card">
            <div class="card-title">CSAT distribution</div>
            ${s.csatCount ? csatRows : '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:20px 0">No CSAT ratings yet</div>'}
          </div>
          <div class="card">
            <div class="card-title">Top customers handled</div>
            ${topCustRows}
          </div>
        </div>

        <div class="card" style="margin-bottom:16px">
          <div class="card-title">Most-used tags</div>
          ${tagsBlock}
        </div>

        <div class="card" style="margin-bottom:16px">
          <div class="card-title">Recent activity</div>
          ${recentRows}
        </div>

        <div class="card">
          <div class="card-title">Assigned tickets</div>
          ${s.tickets.length ? `
            <table class="tbl">
              <thead><tr><th>ID</th><th>Customer</th><th>Subject</th><th>Status</th><th>Priority</th><th>SLA</th><th>Updated</th></tr></thead>
              <tbody>${ticketRows}</tbody>
            </table>
          ` : `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No tickets assigned</div><div class="empty-line"></div></div>`}
        </div>
      </div>
    </div>`;
}

function openAgentDetail(name) { AGENT_SELECTED = name; renderPage('agents'); }
function closeAgentDetail()    { AGENT_SELECTED = null; renderPage('agents'); }
function agentSetRole(v)       { AGENT_FILTER_ROLE = v; renderPage('agents'); }
function agentSetStatus(v)     { AGENT_FILTER_STATUS = v; renderPage('agents'); }
function agentSetQuery(v) {
  AGENT_QUERY = v;
  renderPage('agents');
  const input = document.getElementById('agent-search');
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

function agentNew() {
  if (!isAdmin()) return;
  const allRoles = Object.keys(ROLES_MATRIX);
  showModal('Add agent', `
    <div class="form-grid">
      <div class="form-row"><label class="form-label">Full name</label><input class="form-input" id="ag-name" placeholder="Jane Doe"/></div>
      <div class="form-row"><label class="form-label">Initials</label><input class="form-input" id="ag-init" maxlength="3" placeholder="JD"/></div>
    </div>
    <div class="form-row"><label class="form-label">Role</label>
      <select class="form-input" id="ag-role">${allRoles.map(r => `<option value="${r}" ${r==='Senior Agent'?'selected':''}>${r}</option>`).join('')}</select>
    </div>
  `, () => {
    const name = document.getElementById('ag-name').value.trim();
    const role = document.getElementById('ag-role').value;
    let init = document.getElementById('ag-init').value.trim().toUpperCase();
    if (!name || AGENTS.find(a => a.name === name)) return;
    if (!init) init = name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
    AGENTS.push({ name, initials: init, role, active: true });
    closeModal(); renderPage('agents');
  }, 'Add');
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Workflows ───────────────────────────────────────────────────────────────
let WF_FILTER = 'all';
let WF_QUERY = '';

const WF_TRIGGER_PRESETS = [
  'Ticket created',
  'Status changed',
  'Status changed to Resolved',
  'Priority changed',
  'Priority = Urgent',
  'Category = GDPR',
  'Age > 72h',
  'Last updated > 7d',
  'CSAT < 3',
];

const WF_ACTION_PRESETS = [
  'Assign to Senior Agent',
  'Set status = Resolved',
  'Set priority = High',
  'Add tag: urgent',
  'Notify Manager',
  'Notify DPO',
  'Send email to customer',
  'Send satisfaction survey email',
];

// ─── CSAT surveys ────────────────────────────────────────────────────────────

// ─── Assignment rules ───────────────────────────────────────────────────────

function arNextId() {
  const max = Math.max(0, ...ASSIGN_RULES.map(r => parseInt((r.id||'').split('-')[1] || '0', 10)));
  return `AR-${String(max + 1).padStart(3, '0')}`;
}

function arRuleMatches(rule, t) {
  if (rule.status !== 'active') return false;
  const c = rule.conditions || {};
  if (c.priority && c.priority !== 'all' && c.priority !== t.priority) return false;
  if (c.category && c.category !== 'all' && c.category !== t.category) return false;
  if (c.vip && c.vip !== 'all') {
    const cust = CUSTOMERS.find(x => x.id === t.customerId);
    if (!cust || cust.vip !== c.vip) return false;
  }
  return true;
}

function arPickAgent(rule) {
  const a = rule.assignment || {};
  if (a.mode === 'specific-agent') return a.agent || null;
  // Round-robin and least-busy modes filter out agents who are currently OOO so
  // tickets don't queue up against someone on leave.
  if (a.mode === 'round-robin') {
    const team = (a.team || []).filter(Boolean);
    if (!team.length) return null;
    const available = team.filter(name => !isAgentOOO(name));
    if (!available.length) return null;
    // Walk forward through the FULL team starting at the stored cursor; pick
    // the first available agent. Storing the cursor against `team.length`
    // (not `available.length`) keeps the cycle stable when an OOO agent
    // returns and rejoins the rotation mid-cycle.
    const len = team.length;
    let idx = (ASSIGN_RULES_RR_INDEX[rule.id] || 0) % len;
    let pick = null;
    for (let i = 0; i < len; i++) {
      const candidate = team[(idx + i) % len];
      if (available.includes(candidate)) { pick = candidate; idx = (idx + i); break; }
    }
    if (!pick) return null;
    ASSIGN_RULES_RR_INDEX[rule.id] = (idx + 1) % len;
    return pick;
  }
  if (a.mode === 'least-busy') {
    const team = (a.team || []).filter(Boolean);
    if (!team.length) return null;
    const available = team.filter(name => !isAgentOOO(name));
    if (!available.length) return null;
    // Pick the available team member with the fewest open/escalated tickets.
    const counts = available.map(name => ({
      name,
      n: TICKETS.filter(t => t.agent === name && (t.status === 'open' || t.status === 'escalated')).length,
    }));
    counts.sort((a, b) => a.n - b.n);
    return counts[0].name;
  }
  return null;
}

// ─── Agent out-of-office ────────────────────────────────────────────────────
// Agents flag themselves OOO with a from/to date range and an optional note.
// Assignment rules (round-robin and least-busy) skip OOO agents so tickets
// don't queue up against someone on leave. Direct "specific agent" rules and
// manual assignment still allow assigning to an OOO agent (an admin may
// intentionally page them) but the agent's tile shows the OOO state clearly.
function isAgentOOO(name, atDate) {
  const a = AGENTS.find(x => x.name === name);
  if (!a || !a.oooFrom) return false;
  // Use local date — `<input type="date">` returns local YYYY-MM-DD, so
  // comparing in the same frame avoids a half-day off-by-one around midnight UTC.
  const d = atDate ? new Date(atDate) : new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return today >= a.oooFrom && (!a.oooTo || today <= a.oooTo);
}

// Auth guard: only the agent themselves or an admin may mutate OOO state.
// Surface buttons gate this too, but checking on the mutators keeps it safe
// against console / macro / future automation callers.
function canEditAgentOOO(name) {
  return SESSION && (SESSION.name === name || isAdmin());
}

function setAgentOOO(name, from, to, note) {
  if (!canEditAgentOOO(name)) return;
  const a = AGENTS.find(x => x.name === name);
  if (!a) return;
  if (!from) { delete a.oooFrom; delete a.oooTo; delete a.oooNote; return; }
  a.oooFrom = from;
  a.oooTo = to || null;
  a.oooNote = (note || '').trim() || null;
}

function clearAgentOOO(name) {
  if (!canEditAgentOOO(name)) return;
  setAgentOOO(name, null);
}

function showAgentOOOModal(name) {
  if (!canEditAgentOOO(name)) {
    alert('Only the agent themselves or an admin can edit OOO status.');
    return;
  }
  const a = AGENTS.find(x => x.name === name);
  if (!a) return;
  const today = new Date().toISOString().slice(0, 10);
  showModal(`Out of office · ${escHtml(name)}`, `
    <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">While ${escHtml(a.name.split(' ')[0])} is OOO, the assignment rules engine skips them in round-robin and least-busy modes. Direct assignment still works — admins may intentionally page someone on leave.</div>
    <div class="form-grid">
      <div class="form-row"><label class="form-label">From</label><input class="form-input" type="date" id="ooo-from" value="${escAttr(a.oooFrom || today)}"/></div>
      <div class="form-row"><label class="form-label">Until</label><input class="form-input" type="date" id="ooo-to" value="${escAttr(a.oooTo || '')}"/></div>
    </div>
    <div class="form-row"><label class="form-label">Auto-reply note (optional)</label>
      <input class="form-input" id="ooo-note" value="${escAttr(a.oooNote || '')}" placeholder="e.g. Annual leave — back Friday"/>
    </div>
    ${a.oooFrom ? `<div style="margin-top:14px;text-align:right"><button class="btn btn-sm btn-danger" onclick="clearAgentOOO('${escAttr(name)}');closeModal();renderPage(CURRENT_PAGE)">Clear OOO</button></div>` : ''}
  `, () => {
    const from = document.getElementById('ooo-from').value;
    const to   = document.getElementById('ooo-to').value;
    const note = document.getElementById('ooo-note').value;
    if (!from) { alert('Pick a start date.'); return; }
    if (to && to < from) { alert('End date must be on or after the start date.'); return; }
    setAgentOOO(name, from, to, note);
    closeModal();
    renderPage(CURRENT_PAGE);
  }, 'Save');
}

function applyAssignmentRules(t) {
  if (!t) return null;
  const ordered = [...ASSIGN_RULES].sort((a, b) => (a.priority || 99) - (b.priority || 99));
  for (const rule of ordered) {
    if (!arRuleMatches(rule, t)) continue;
    const agent = arPickAgent(rule);
    if (!agent) continue;
    if (t.agent !== agent) {
      logTicketEvent(t.id, 'assign', `Assigned by rule ${rule.id} (${rule.name}): ${t.agent || 'Unassigned'} → ${agent}`);
    }
    t.agent = agent;
    rule.matchCount = (rule.matchCount || 0) + 1;
    rule.lastMatchAt = new Date().toISOString().slice(0, 10);
    return rule;
  }
  return null;
}

function runAssignmentRulesOnTicket(id) {
  const t = TICKETS.find(x => x.id === id);
  if (!t) return;
  const rule = applyAssignmentRules(t);
  if (!rule) {
    alert('No active rule matched this ticket.');
    return;
  }
  if (CURRENT_TICKET === id) openTicket(id);
  else renderPage(CURRENT_PAGE || 'tickets');
}

function bulkApplyAssignmentRules() {
  if (TICKET_SELECTED_IDS.size === 0) return;
  let matched = 0;
  [...TICKET_SELECTED_IDS].forEach(id => {
    const t = TICKETS.find(x => x.id === id);
    if (t && applyAssignmentRules(t)) matched++;
  });
  TICKET_SELECTED_IDS.clear();
  renderPage('tickets');
  alert(matched ? `Assignment rules matched ${matched} ticket${matched===1?'':'s'}.` : 'No active rule matched any ticket in the selection.');
}

function arToggle(id, active) {
  if (!isAdmin()) return;
  const r = ASSIGN_RULES.find(x => x.id === id);
  if (r) r.status = active ? 'active' : 'inactive';
}

function arConditionsSummary(c) {
  const bits = [];
  if (c.priority && c.priority !== 'all') bits.push(`priority=<strong>${escHtml(c.priority)}</strong>`);
  if (c.category && c.category !== 'all') bits.push(`category=<strong>${escHtml(c.category)}</strong>`);
  if (c.vip && c.vip !== 'all') bits.push(`VIP=<strong>${escHtml(c.vip)}</strong>`);
  return bits.length ? bits.join(' · ') : '<span style="color:var(--ink3)">any ticket</span>';
}

function arAssignmentSummary(a) {
  if (!a) return '<span style="color:var(--ink3)">—</span>';
  if (a.mode === 'specific-agent') return `→ <strong>${escHtml(a.agent || '—')}</strong>`;
  if (a.mode === 'round-robin')    return `↻ round-robin · ${(a.team||[]).map(escHtml).join(', ') || '—'}`;
  if (a.mode === 'least-busy')     return `↧ least-busy · ${(a.team||[]).map(escHtml).join(', ') || '—'}`;
  return escHtml(a.mode);
}

function arFormBody(r) {
  const esc = s => String(s||'').replace(/"/g,'&quot;');
  const cats = ['all', ...new Set(TICKETS.map(t => t.category))];
  const vipOpts = ['all','Gold','Silver','Standard'];
  const c = r?.conditions || { priority:'all', category:'all', vip:'all' };
  const a = r?.assignment || { mode:'round-robin', team:[] };
  const teamCsv = (a.team || []).join(', ');
  return `
    <div class="form-row"><label class="form-label">Name</label><input class="form-input" id="ar-name" value="${esc(r?.name)}" placeholder="e.g. Urgent · Billing → Sofia"/></div>
    <div class="form-grid">
      <div class="form-row"><label class="form-label">Priority (lower wins)</label><input class="form-input" type="number" id="ar-priority" value="${r?.priority ?? 50}" min="1" max="999"/></div>
      <div class="form-row"><label class="form-label">Status</label>
        <select class="form-input" id="ar-status">
          <option value="active"   ${(r?.status || 'active')==='active'?'selected':''}>Active</option>
          <option value="inactive" ${r?.status==='inactive'?'selected':''}>Inactive</option>
        </select>
      </div>
    </div>
    <div style="font-size:11px;font-weight:600;color:var(--ink2);text-transform:uppercase;letter-spacing:.06em;margin:14px 0 8px">When</div>
    <div class="form-grid">
      <div class="form-row"><label class="form-label">Priority</label>
        <select class="form-input" id="ar-cond-priority">${['all','urgent','high','normal','low'].map(p=>`<option value="${p}" ${c.priority===p?'selected':''}>${p==='all'?'Any':p}</option>`).join('')}</select>
      </div>
      <div class="form-row"><label class="form-label">Category</label>
        <select class="form-input" id="ar-cond-category">${cats.map(x=>`<option value="${escAttr(x)}" ${c.category===x?'selected':''}>${x==='all'?'Any':escHtml(x)}</option>`).join('')}</select>
      </div>
      <div class="form-row"><label class="form-label">VIP tier</label>
        <select class="form-input" id="ar-cond-vip">${vipOpts.map(v=>`<option value="${v}" ${c.vip===v?'selected':''}>${v==='all'?'Any':v}</option>`).join('')}</select>
      </div>
    </div>
    <div style="font-size:11px;font-weight:600;color:var(--ink2);text-transform:uppercase;letter-spacing:.06em;margin:14px 0 8px">Then assign</div>
    <div class="form-row"><label class="form-label">Mode</label>
      <select class="form-input" id="ar-mode" onchange="arModeChanged(this.value)">
        <option value="specific-agent" ${a.mode==='specific-agent'?'selected':''}>Specific agent</option>
        <option value="round-robin"    ${a.mode==='round-robin'?'selected':''}>Round-robin (cycle through team)</option>
        <option value="least-busy"     ${a.mode==='least-busy'?'selected':''}>Least-busy (fewest open tickets)</option>
      </select>
    </div>
    <div class="form-row" id="ar-agent-row" style="display:${a.mode==='specific-agent'?'block':'none'}">
      <label class="form-label">Agent</label>
      <select class="form-input" id="ar-agent">${AGENTS.map(ag=>`<option value="${escAttr(ag.name)}" ${a.agent===ag.name?'selected':''}>${escHtml(ag.name)}</option>`).join('')}</select>
    </div>
    <div class="form-row" id="ar-team-row" style="display:${a.mode==='specific-agent'?'none':'block'}">
      <label class="form-label">Team (comma-separated agent names)</label>
      <input class="form-input" id="ar-team" value="${esc(teamCsv)}" placeholder="Emma Clarke, Sofia Reyes"/>
      <div style="font-size:11px;color:var(--ink3);margin-top:4px">Round-robin cycles through the team in order. Least-busy picks the agent with fewest open + escalated tickets.</div>
    </div>`;
}

function arModeChanged(mode) {
  const agentRow = document.getElementById('ar-agent-row');
  const teamRow  = document.getElementById('ar-team-row');
  if (agentRow) agentRow.style.display = mode === 'specific-agent' ? 'block' : 'none';
  if (teamRow)  teamRow.style.display  = mode === 'specific-agent' ? 'none' : 'block';
}

function arReadForm() {
  const mode = document.getElementById('ar-mode').value;
  const assignment = { mode };
  if (mode === 'specific-agent') {
    assignment.agent = document.getElementById('ar-agent').value;
  } else {
    const csv = document.getElementById('ar-team').value;
    assignment.team = csv.split(',').map(s => s.trim()).filter(Boolean);
  }
  return {
    name: document.getElementById('ar-name').value.trim(),
    priority: parseInt(document.getElementById('ar-priority').value, 10) || 50,
    status: document.getElementById('ar-status').value,
    conditions: {
      priority: document.getElementById('ar-cond-priority').value,
      category: document.getElementById('ar-cond-category').value,
      vip:      document.getElementById('ar-cond-vip').value,
    },
    assignment,
  };
}

function arNew() {
  if (!isAdmin()) return;
  showModal('New assignment rule', arFormBody(null), () => {
    const data = arReadForm();
    if (!data.name) { alert('Name is required.'); return; }
    if (data.assignment.mode === 'specific-agent' && !data.assignment.agent) { alert('Pick an agent.'); return; }
    if (data.assignment.mode !== 'specific-agent' && !(data.assignment.team || []).length) { alert('Team is required.'); return; }
    ASSIGN_RULES.push({ id: arNextId(), matchCount: 0, lastMatchAt: null, ...data });
    closeModal(); renderPage('assignment-rules');
  }, 'Create');
}

function arEdit(id) {
  if (!isAdmin()) return;
  const r = ASSIGN_RULES.find(x => x.id === id); if (!r) return;
  showModal('Edit rule · ' + r.id, arFormBody(r), () => {
    const data = arReadForm();
    if (!data.name) { alert('Name is required.'); return; }
    if (data.assignment.mode === 'specific-agent' && !data.assignment.agent) { alert('Pick an agent.'); return; }
    if (data.assignment.mode !== 'specific-agent' && !(data.assignment.team || []).length) { alert('Team is required.'); return; }
    Object.assign(r, data);
    delete ASSIGN_RULES_RR_INDEX[r.id];
    closeModal(); renderPage('assignment-rules');
  }, 'Save');
}

function arDelete(id) {
  if (!isAdmin()) return;
  const r = ASSIGN_RULES.find(x => x.id === id); if (!r) return;
  showModal('Delete rule', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${escHtml(r.name)}</strong>?</div>`, () => {
    const i = ASSIGN_RULES.findIndex(x => x.id === id);
    if (i >= 0) ASSIGN_RULES.splice(i, 1);
    delete ASSIGN_RULES_RR_INDEX[id];
    closeModal(); renderPage('assignment-rules');
  }, 'Delete');
}

function renderAssignmentRules() {
  const admin = isAdmin();
  let list = [...ASSIGN_RULES].sort((a, b) => (a.priority || 99) - (b.priority || 99));
  if (AR_FILTER === 'active')   list = list.filter(r => r.status === 'active');
  if (AR_FILTER === 'inactive') list = list.filter(r => r.status === 'inactive');
  const total = ASSIGN_RULES.length;
  const activeN = ASSIGN_RULES.filter(r => r.status === 'active').length;
  const totalMatches = ASSIGN_RULES.reduce((s, r) => s + (r.matchCount || 0), 0);
  const top = [...ASSIGN_RULES].sort((a,b)=>(b.matchCount||0)-(a.matchCount||0))[0];

  const rows = list.map(r => `
    <tr>
      <td style="font-family:'DM Mono',monospace;font-size:12px;text-align:center">${r.priority || 50}</td>
      <td><strong>${escHtml(r.name)}</strong><div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);margin-top:2px">${escHtml(r.id)}</div></td>
      <td style="font-size:11px;color:var(--ink2)">${arConditionsSummary(r.conditions || {})}</td>
      <td style="font-size:11px;color:var(--ink2)">${arAssignmentSummary(r.assignment)}</td>
      <td style="font-family:'DM Mono',monospace;font-size:12px">${r.matchCount || 0}</td>
      <td style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3)">${escHtml(r.lastMatchAt || '—')}</td>
      <td style="text-align:center">
        <label class="toggle">
          <input type="checkbox" ${r.status==='active'?'checked':''} ${admin?'':'disabled'} onchange="arToggle('${escAttr(r.id)}',this.checked)">
          <span class="toggle-slider"></span>
        </label>
      </td>
      ${admin ? `<td style="text-align:right;white-space:nowrap">
        <button class="btn btn-sm" onclick="arEdit('${escAttr(r.id)}')">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="arDelete('${escAttr(r.id)}')">Delete</button>
      </td>` : ''}
    </tr>`).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Assignment Rules</div>
        ${admin
          ? `<button class="btn btn-solid btn-sm" onclick="arNew()">+ New Rule</button>`
          : `<span style="font-size:11px;color:var(--ink3);font-style:italic">Read-only — admin access required to edit</span>`}
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Rules</div></div>
        <div class="kpi"><div class="kpi-n c-green">${activeN}</div><div class="kpi-l">Active</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${totalMatches}</div><div class="kpi-l">Total matches</div></div>
        <div class="kpi"><div class="kpi-n c-purple" style="font-size:18px;line-height:1.1">${top ? escHtml(top.name) : '—'}</div><div class="kpi-l">Most used ${top ? '· ' + (top.matchCount || 0) : ''}</div></div>
      </div>
      <div class="filter-bar">
        <span class="filter-label">Filter</span>
        <select class="filter-select" onchange="AR_FILTER=this.value;renderPage('assignment-rules')">
          <option value="all"      ${AR_FILTER==='all'?'selected':''}>All rules</option>
          <option value="active"   ${AR_FILTER==='active'?'selected':''}>Active</option>
          <option value="inactive" ${AR_FILTER==='inactive'?'selected':''}>Inactive</option>
        </select>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${total}</span>
      </div>
      <div class="page-scroll">
        <table class="tbl">
          <thead><tr>
            <th style="width:50px;text-align:center">#</th><th>Rule</th><th>When</th><th>Then assign</th><th>Matches</th><th>Last match</th>
            <th style="text-align:center">Active</th>
            ${admin?'<th style="text-align:right">Actions</th>':''}
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${list.length===0 ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No rules match</div><div class="empty-line"></div></div>` : ''}
        <div style="margin-top:14px;font-size:11px;color:var(--ink3);line-height:1.5;padding:0 4px">Rules are evaluated in ascending priority order; the first matching active rule wins. Apply rules manually from the ticket sidebar (<strong style="color:var(--ink2)">Run rules</strong>) or to a selection from the bulk action bar. New tickets created with "Auto" assignment go through this engine.</div>
      </div>
    </div>`;
}

// ─── Business Hours page ────────────────────────────────────────────────────
function bhSetEnabled(v) {
  BUSINESS_HOURS.enabled = !!v;
  invalidateSLAClock();
  refreshAllSLA();
  renderPage('business-hours');
}

function bhSetDayEnabled(idx, v) {
  const d = BUSINESS_HOURS.days[idx];
  if (!d) return;
  d.enabled = !!v;
  invalidateSLAClock();
  refreshAllSLA();
  renderPage('business-hours');
}

function bhSetDayTime(idx, field, v) {
  const d = BUSINESS_HOURS.days[idx];
  if (!d) return;
  if (!bhParseHM(v)) return;
  d[field] = v;
  invalidateSLAClock();
  refreshAllSLA();
}

function bhAddHoliday() {
  const el = document.getElementById('bh-new-holiday');
  if (!el) return;
  const v = el.value;
  if (!v) return;
  if (!BUSINESS_HOURS.holidays.includes(v)) BUSINESS_HOURS.holidays.push(v);
  BUSINESS_HOURS.holidays.sort();
  invalidateSLAClock();
  refreshAllSLA();
  renderPage('business-hours');
}

function bhRemoveHoliday(date) {
  const i = BUSINESS_HOURS.holidays.indexOf(date);
  if (i < 0) return;
  BUSINESS_HOURS.holidays.splice(i, 1);
  invalidateSLAClock();
  refreshAllSLA();
  renderPage('business-hours');
}

function renderBusinessHours() {
  const admin = isAdmin();
  const now = new Date();
  const inHours = isWithinBusinessHours(now);
  const dayRows = BUSINESS_HOURS.days.map((d, i) => `
    <tr>
      <td style="width:80px;font-weight:500;color:var(--ink)">${escHtml(d.label)}</td>
      <td style="width:60px;text-align:center">
        <label class="toggle">
          <input type="checkbox" ${d.enabled ? 'checked' : ''} ${admin ? '' : 'disabled'} onchange="bhSetDayEnabled(${i},this.checked)">
          <span class="toggle-slider"></span>
        </label>
      </td>
      <td>
        <input type="time" class="form-input" value="${escAttr(d.start)}" style="max-width:120px" ${admin && d.enabled ? '' : 'disabled'} onchange="bhSetDayTime(${i},'start',this.value)"/>
      </td>
      <td>
        <input type="time" class="form-input" value="${escAttr(d.end)}" style="max-width:120px" ${admin && d.enabled ? '' : 'disabled'} onchange="bhSetDayTime(${i},'end',this.value)"/>
      </td>
      <td style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3)">${d.enabled ? escHtml(`${d.start}–${d.end}`) : '<span style="font-style:italic">closed</span>'}</td>
    </tr>`).join('');

  const holidayRows = BUSINESS_HOURS.holidays.map(date => `
    <div style="display:flex;align-items:center;gap:10px;padding:6px 10px;border:1px solid var(--rule);border-radius:var(--r);margin-bottom:4px;background:var(--off2)">
      <span style="font-family:'DM Mono',monospace;font-size:12px;color:var(--ink2)">${escHtml(date)}</span>
      <span style="font-size:11px;color:var(--ink3);font-style:italic">${escHtml(new Date(date).toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'short' }))}</span>
      ${admin ? `<button class="btn btn-sm" style="margin-left:auto" onclick="bhRemoveHoliday(${escHtml(JSON.stringify(date))})">Remove</button>` : ''}
    </div>`).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Business Hours</div>
        <span style="font-size:11px;color:${inHours ? 'var(--green)' : 'var(--ink3)'};font-weight:500">${inHours ? '● Currently in business hours' : '○ Currently outside business hours'}</span>
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n c-${BUSINESS_HOURS.enabled ? 'green' : 'red'}" style="font-size:18px;line-height:1.1">${BUSINESS_HOURS.enabled ? 'On' : 'Off'}</div><div class="kpi-l">SLA pause</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${BUSINESS_HOURS.days.filter(d => d.enabled).length}</div><div class="kpi-l">Working days</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${BUSINESS_HOURS.holidays.length}</div><div class="kpi-l">Holidays</div></div>
      </div>
      <div class="filter-bar">
        <span class="filter-label">SLA pause outside business hours</span>
        <label class="toggle" style="margin-left:8px">
          <input type="checkbox" ${BUSINESS_HOURS.enabled ? 'checked' : ''} ${admin ? '' : 'disabled'} onchange="bhSetEnabled(this.checked)">
          <span class="toggle-slider"></span>
        </label>
        <span style="font-size:11px;color:var(--ink3);margin-left:auto;font-style:italic">${admin ? 'Changes apply to live SLA evaluation immediately.' : 'Read-only — admin access required to edit'}</span>
      </div>
      <div class="page-scroll">
        <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:14px">
          <div class="card">
            <div class="card-title">Weekly schedule</div>
            <table class="tbl" style="margin-top:8px">
              <thead><tr><th>Day</th><th style="text-align:center">Open</th><th>Start</th><th>End</th><th>Window</th></tr></thead>
              <tbody>${dayRows}</tbody>
            </table>
            <div style="margin-top:10px;font-size:11px;color:var(--ink3);line-height:1.5">When SLA pause is on, only minutes inside an open window count against a ticket's SLA timer. First-response thresholds count business minutes too once the customer's first message lands.</div>
          </div>
          <div class="card">
            <div class="card-title">Holidays (${BUSINESS_HOURS.holidays.length})</div>
            <div style="font-size:11px;color:var(--ink3);margin-bottom:10px;line-height:1.5">Dates listed here count as fully closed regardless of weekday schedule.</div>
            ${holidayRows || '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:14px 0">No holidays added</div>'}
            ${admin ? `
              <div style="display:flex;gap:6px;margin-top:10px">
                <input type="date" class="form-input" id="bh-new-holiday" style="flex:1"/>
                <button class="btn btn-sm" onclick="bhAddHoliday()">+ Add</button>
              </div>` : ''}
          </div>
        </div>
      </div>
    </div>`;
}

// ─── SLA policies ────────────────────────────────────────────────────────────

function fmtSLAMinutes(min) {
  if (!min || min < 1) return '—';
  if (min < 60) return `${min}m`;
  if (min < 1440) {
    const h = Math.floor(min / 60), rest = min % 60;
    return rest ? `${h}h ${rest}m` : `${h}h`;
  }
  const d = Math.floor(min / 1440), rest = min % 1440;
  return rest ? `${d}d ${Math.round(rest/60)}h` : `${d}d`;
}

function renderSLA() {
  const admin = isAdmin();
  let list = [...SLA_POLICIES];
  if (SLA_FILTER === 'active')   list = list.filter(p => p.status === 'active');
  if (SLA_FILTER === 'inactive') list = list.filter(p => p.status === 'inactive');
  const total    = SLA_POLICIES.length;
  const activeN  = SLA_POLICIES.filter(p => p.status === 'active').length;
  const avgFirst = activeN ? Math.round(SLA_POLICIES.filter(p => p.status==='active').reduce((s,p)=>s+p.firstResponseMin,0) / activeN) : 0;
  const avgRes   = activeN ? Math.round(SLA_POLICIES.filter(p => p.status==='active').reduce((s,p)=>s+p.resolutionMin,0)   / activeN) : 0;

  // Compute, per-policy, how many open tickets currently match it (resolved tickets excluded)
  const policyTicketCounts = {};
  TICKETS.forEach(t => {
    if (t.status === 'resolved') return;
    const m = findMatchingSLAPolicy(t);
    if (m) policyTicketCounts[m.id] = (policyTicketCounts[m.id] || 0) + 1;
  });

  const rows = list.map(p => {
    const matched = policyTicketCounts[p.id] || 0;
    return `
    <tr>
      <td class="bold">${p.id}</td>
      <td style="font-weight:500;color:var(--ink)">${p.name}</td>
      <td><span class="tag tag-${p.priority}">${p.priority}</span></td>
      <td>${p.category === 'all' ? '<span style="color:var(--ink3)">Any</span>' : p.category}</td>
      <td style="font-family:'DM Mono',monospace;font-size:12px">${fmtSLAMinutes(p.firstResponseMin)}</td>
      <td style="font-family:'DM Mono',monospace;font-size:12px">${fmtSLAMinutes(p.resolutionMin)}</td>
      <td style="font-family:'DM Mono',monospace;font-size:12px;color:${matched ? 'var(--ink2)' : 'var(--ink4)'}">${matched}</td>
      <td style="text-align:center">
        <label class="toggle">
          <input type="checkbox" ${p.status==='active'?'checked':''} ${admin?'':'disabled'} onchange="slaToggle('${escAttr(p.id)}',this.checked)">
          <span class="toggle-slider"></span>
        </label>
      </td>
      ${admin ? `<td style="text-align:right;white-space:nowrap">
        <button class="btn btn-sm" onclick="slaEdit('${escAttr(p.id)}')">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="slaDelete('${escAttr(p.id)}')">Delete</button>
      </td>` : ''}
    </tr>`;
  }).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">SLA Policies</div>
        ${admin
          ? `<button class="btn btn-solid btn-sm" onclick="slaNew()">+ New Policy</button>`
          : `<span style="font-size:11px;color:var(--ink3);font-style:italic">Read-only — admin access required to edit</span>`}
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Policies</div></div>
        <div class="kpi"><div class="kpi-n c-green">${activeN}</div><div class="kpi-l">Active</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${fmtSLAMinutes(avgFirst)}</div><div class="kpi-l">Avg first-response</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${fmtSLAMinutes(avgRes)}</div><div class="kpi-l">Avg resolution</div></div>
      </div>
      <div class="filter-bar">
        <span class="filter-label">Filter</span>
        <select class="filter-select" onchange="SLA_FILTER=this.value;renderPage('sla')">
          <option value="all"      ${SLA_FILTER==='all'?'selected':''}>All policies</option>
          <option value="active"   ${SLA_FILTER==='active'?'selected':''}>Active</option>
          <option value="inactive" ${SLA_FILTER==='inactive'?'selected':''}>Inactive</option>
        </select>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${total}</span>
      </div>
      <div class="page-scroll">
        <table class="tbl">
          <thead><tr>
            <th>ID</th><th>Name</th><th>Priority</th><th>Category</th><th>First response</th><th>Resolution</th><th>Open tickets</th>
            <th style="text-align:center">Active</th>
            ${admin?'<th style="text-align:right">Actions</th>':''}
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${list.length===0 ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No policies match</div><div class="empty-line"></div></div>` : ''}
        <div style="margin-top:14px;font-size:11px;color:var(--ink3);line-height:1.5;padding:0 4px">Policies are evaluated by priority + category match. The most-specific matching active policy wins (specific category beats <strong style="color:var(--ink2)">Any</strong>). Times are in minutes; values render as <strong style="color:var(--ink2)">Xm</strong>, <strong style="color:var(--ink2)">Yh Zm</strong>, or <strong style="color:var(--ink2)">Nd Yh</strong>.</div>
      </div>
    </div>`;
}

function slaToggle(id, active) {
  if (!isAdmin()) return;
  const p = SLA_POLICIES.find(x => x.id === id);
  if (p) p.status = active ? 'active' : 'inactive';
}

function slaFormBody(p) {
  const cats = ['all', ...new Set(TICKETS.map(t => t.category))];
  const esc = s => String(s||'').replace(/"/g,'&quot;');
  return `
    <div class="form-row"><label class="form-label">Name</label><input class="form-input" id="sla-name" value="${esc(p?.name)}" placeholder="e.g. Urgent · Technical"/></div>
    <div class="form-grid">
      <div class="form-row"><label class="form-label">Priority</label>
        <select class="form-input" id="sla-priority">
          ${['urgent','high','normal','low'].map(pr => `<option value="${pr}" ${p?.priority===pr?'selected':''}>${pr}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label class="form-label">Category</label>
        <select class="form-input" id="sla-category">
          ${cats.map(c => `<option value="${c}" ${(p?.category||'all')===c?'selected':''}>${c==='all'?'Any':c}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label class="form-label">First response (minutes)</label><input class="form-input" id="sla-first" type="number" min="1" value="${p?.firstResponseMin||60}"/></div>
      <div class="form-row"><label class="form-label">Resolution (minutes)</label><input class="form-input" id="sla-res" type="number" min="1" value="${p?.resolutionMin||1440}"/></div>
    </div>
    <div style="display:flex;align-items:center;gap:10px;padding:6px 0">
      <span style="font-family:'Inter',sans-serif;font-size:11px;font-weight:500;letter-spacing:.04em;text-transform:uppercase;color:var(--ink3)">Active</span>
      <label class="toggle"><input type="checkbox" id="sla-active" ${(!p || p.status==='active')?'checked':''}><span class="toggle-slider"></span></label>
    </div>
    <div id="sla-form-error" style="display:none;margin-top:8px;font-size:11px;color:var(--red);font-family:'DM Mono',monospace;letter-spacing:.04em"></div>`;
}

function slaNextId() {
  const max = Math.max(0, ...SLA_POLICIES.map(x => parseInt((x.id||'').split('-')[1] || '0', 10)));
  return 'SLA-' + String(max + 1).padStart(3, '0');
}

function slaShowError(msg) {
  const el = document.getElementById('sla-form-error');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}

function slaReadAndValidate() {
  const name  = document.getElementById('sla-name').value.trim();
  const first = parseInt(document.getElementById('sla-first').value, 10);
  const res   = parseInt(document.getElementById('sla-res').value, 10);
  if (!name) { slaShowError('Name is required.'); return null; }
  if (!Number.isFinite(first) || first < 1) { slaShowError('First response must be a positive number of minutes.'); return null; }
  if (!Number.isFinite(res)   || res   < 1) { slaShowError('Resolution must be a positive number of minutes.'); return null; }
  if (res < first) { slaShowError('Resolution must be at least the first-response window.'); return null; }
  return {
    name,
    priority: document.getElementById('sla-priority').value,
    category: document.getElementById('sla-category').value,
    firstResponseMin: first,
    resolutionMin: res,
    status: document.getElementById('sla-active').checked ? 'active' : 'inactive',
  };
}

function slaNew() {
  if (!isAdmin()) return;
  showModal('New SLA policy', slaFormBody(null), () => {
    const data = slaReadAndValidate(); if (!data) return;
    SLA_POLICIES.unshift({ id: slaNextId(), ...data });
    closeModal(); renderPage('sla');
  }, 'Create');
}

function slaEdit(id) {
  if (!isAdmin()) return;
  const p = SLA_POLICIES.find(x => x.id === id); if (!p) return;
  showModal(`Edit ${p.id}`, slaFormBody(p), () => {
    const data = slaReadAndValidate(); if (!data) return;
    Object.assign(p, data);
    closeModal(); renderPage('sla');
  }, 'Save');
}

function slaDelete(id) {
  if (!isAdmin()) return;
  const p = SLA_POLICIES.find(x => x.id === id); if (!p) return;
  showModal('Delete policy', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${p.name}</strong>?</div>`, () => {
    const i = SLA_POLICIES.findIndex(x => x.id === id);
    if (i >= 0) SLA_POLICIES.splice(i, 1);
    closeModal(); renderPage('sla');
  }, 'Delete');
}

function renderWorkflows() {
  if (WF_SELECTED) return renderWfDetail(WF_SELECTED);
  const admin = isAdmin();
  let list = [...WORKFLOWS];
  if (WF_FILTER === 'active')   list = list.filter(w => w.status === 'active');
  if (WF_FILTER === 'inactive') list = list.filter(w => w.status === 'inactive');
  if (WF_QUERY.trim()) {
    const q = WF_QUERY.toLowerCase();
    list = list.filter(w => w.name.toLowerCase().includes(q) || w.trigger.toLowerCase().includes(q) || w.action.toLowerCase().includes(q) || w.id.toLowerCase().includes(q));
  }

  const total      = WORKFLOWS.length;
  const activeN    = WORKFLOWS.filter(w => w.status === 'active').length;
  const inactiveN  = total - activeN;
  const totalRuns  = WORKFLOWS.reduce((a, w) => a + (w.runCount || 0), 0);

  const rows = list.map(w => `
    <tr onclick="openWfDetail('${escAttr(w.id)}')" style="cursor:pointer">
      <td class="bold">${w.id}</td>
      <td style="font-weight:500;color:var(--ink)">${w.name}</td>
      <td style="font-size:12px;color:var(--ink2);max-width:240px">${w.trigger}</td>
      <td style="font-size:12px;color:var(--ink2);max-width:240px">${w.action}</td>
      <td style="font-family:'DM Mono',monospace;font-size:12px">${w.runCount || 0}</td>
      <td style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3)">${w.lastRun || '—'}</td>
      <td style="text-align:center" onclick="event.stopPropagation()">
        <label class="toggle">
          <input type="checkbox" ${w.status==='active'?'checked':''} ${admin?'':'disabled'} onchange="wfToggle('${escAttr(w.id)}',this.checked)">
          <span class="toggle-slider"></span>
        </label>
      </td>
      ${admin ? `<td style="text-align:right;white-space:nowrap" onclick="event.stopPropagation()">
        <button class="btn btn-sm" onclick="wfRunNow('${escAttr(w.id)}')" title="Simulate a run">Run</button>
        <button class="btn btn-sm" onclick="duplicateWf('${escAttr(w.id)}')" title="Duplicate">Copy</button>
        <button class="btn btn-sm" onclick="wfEdit('${escAttr(w.id)}')">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="wfDelete('${escAttr(w.id)}')">Delete</button>
      </td>` : ''}
    </tr>`).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Workflows</div>
        ${admin
          ? `<button class="btn btn-solid btn-sm" onclick="wfNew()">+ New Workflow</button>`
          : `<span style="font-size:11px;color:var(--ink3);font-style:italic">Read-only — admin access required to edit</span>`}
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Total</div></div>
        <div class="kpi"><div class="kpi-n c-green">${activeN}</div><div class="kpi-l">Active</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${inactiveN}</div><div class="kpi-l">Inactive</div></div>
        <div class="kpi"><div class="kpi-n c-purple">${totalRuns}</div><div class="kpi-l">Runs (30d)</div></div>
      </div>
      <div class="filter-bar">
        <span class="filter-label">Filter</span>
        <input class="filter-select" id="wf-search" placeholder="Search workflows…" style="width:240px" value="${WF_QUERY}" oninput="wfSetQuery(this.value)"/>
        <select class="filter-select" onchange="wfSetFilter(this.value)">
          <option value="all"      ${WF_FILTER==='all'?'selected':''}>All workflows</option>
          <option value="active"   ${WF_FILTER==='active'?'selected':''}>Active</option>
          <option value="inactive" ${WF_FILTER==='inactive'?'selected':''}>Inactive</option>
        </select>
        ${WF_QUERY?`<span class="filter-tag">"${WF_QUERY}"<span class="rm" onclick="wfSetQuery('')">×</span></span>`:''}
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${total}</span>
      </div>
      <div style="flex:1;overflow-y:auto">
        <table class="tbl">
          <thead><tr>
            <th>ID</th><th>Name</th><th>Trigger</th><th>Action</th><th>Runs</th><th>Last run</th><th style="text-align:center">Active</th>
            ${admin ? '<th style="text-align:right">Actions</th>' : ''}
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${list.length===0 ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No workflows match the filter</div><div class="empty-line"></div></div>` : ''}
      </div>
    </div>`;
}

function wfSetFilter(v) { WF_FILTER = v; renderPage('workflows'); }

function wfToggle(id, active) {
  if (!isAdmin()) return;
  const w = WORKFLOWS.find(x => x.id === id);
  if (w) w.status = active ? 'active' : 'inactive';
}

function wfRunNow(id) {
  if (!isAdmin()) return;
  const w = WORKFLOWS.find(x => x.id === id);
  if (!w) return;
  w.runCount = (w.runCount || 0) + 1;
  w.lastRun = 'just now';
  if (!w.history) w.history = [];
  w.history.unshift({
    ts: new Date().toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }),
    triggeredBy: SESSION?.name || 'System',
    type: 'manual',
  });
  if (w.history.length > 50) w.history.length = 50;
  renderPage('workflows');
}

function duplicateWf(id) {
  if (!isAdmin()) return;
  const orig = WORKFLOWS.find(x => x.id === id);
  if (!orig) return;
  const newId = 'WF-' + String(WORKFLOWS.length + 1).padStart(3, '0');
  WORKFLOWS.unshift({
    id: newId,
    name: orig.name + ' (copy)',
    trigger: orig.trigger,
    action: orig.action,
    status: 'inactive',
    runCount: 0,
    lastRun: null,
    history: [],
  });
  renderPage('workflows');
}

function openWfDetail(id) { WF_SELECTED = id; renderPage('workflows'); }
function closeWfDetail()  { WF_SELECTED = null; renderPage('workflows'); }
function wfSetQuery(q) {
  WF_QUERY = q;
  renderPage('workflows');
  const input = document.getElementById('wf-search');
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

function renderWfDetail(id) {
  const w = WORKFLOWS.find(x => x.id === id);
  if (!w) { WF_SELECTED = null; return renderWorkflows(); }
  const admin = isAdmin();
  const history = w.history || [];
  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-breadcrumb">
          <span onclick="closeWfDetail()">Workflows</span>
          <span class="tb-sep">/</span>
          <span style="color:var(--ink);font-weight:500">${w.name}</span>
          ${admin ? `<span style="margin-left:auto;display:flex;gap:6px">
            <button class="btn btn-sm" onclick="wfRunNow('${escAttr(w.id)}')">Run now</button>
            <button class="btn btn-sm" onclick="duplicateWf('${escAttr(w.id)}')">Duplicate</button>
            <button class="btn btn-sm" onclick="wfEdit('${escAttr(w.id)}')">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="wfDelete('${escAttr(w.id)}')">Delete</button>
          </span>` : ''}
        </div>
      </div>
      <div class="page-scroll">
        <div class="card" style="display:flex;gap:18px;align-items:center;padding:20px;margin-bottom:16px">
          <div style="width:54px;height:54px;border-radius:var(--r2);background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M3 12h4l3-7 4 14 3-7h4" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:20px;font-weight:700;color:var(--ink);letter-spacing:-.02em">${w.name}</div>
            <div style="font-size:13px;color:var(--ink3);margin-top:6px">${w.id} · ${w.runCount || 0} run${w.runCount===1?'':'s'}${w.lastRun ? ' · last ' + w.lastRun : ''}</div>
          </div>
          ${admin
            ? `<label class="toggle"><input type="checkbox" ${w.status==='active'?'checked':''} onchange="wfToggle('${escAttr(w.id)}',this.checked);renderPage('workflows')"><span class="toggle-slider"></span></label>`
            : `<span class="tag ${w.status==='active'?'tag-resolved':'tag-pending'}" style="text-transform:capitalize">${w.status}</span>`}
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
          <div class="card">
            <div class="card-title">When (trigger)</div>
            <div style="font-size:13px;color:var(--ink);line-height:1.6">${w.trigger}</div>
          </div>
          <div class="card">
            <div class="card-title">Then (action)</div>
            <div style="font-size:13px;color:var(--ink);line-height:1.6">${w.action}</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
          <div class="r-tile" style="border-color:rgba(139,92,246,0.3);background:var(--purple-lt)"><div class="r-tile-n" style="color:var(--purple)">${w.runCount || 0}</div><div class="r-tile-l" style="color:var(--purple)">Total runs</div></div>
          <div class="r-tile"><div class="r-tile-n" style="color:var(--ink);font-size:14px;line-height:1.3">${w.lastRun || '—'}</div><div class="r-tile-l" style="color:var(--ink3)">Last run</div></div>
          <div class="r-tile" style="border-color:${w.status==='active'?'rgba(52,211,153,0.3)':'rgba(251,191,36,0.3)'};background:${w.status==='active'?'var(--green-lt)':'var(--amber-lt)'}"><div class="r-tile-n" style="color:${w.status==='active'?'var(--green)':'var(--amber)'};font-size:16px;text-transform:capitalize">${w.status}</div><div class="r-tile-l" style="color:${w.status==='active'?'var(--green)':'var(--amber)'}">Status</div></div>
          <div class="r-tile"><div class="r-tile-n" style="color:var(--ink)">${history.length}</div><div class="r-tile-l" style="color:var(--ink3)">Logged events</div></div>
        </div>

        <div class="card">
          <div class="card-title">Run history</div>
          ${history.length ? `
            <div style="display:flex;flex-direction:column;gap:6px;max-height:520px;overflow-y:auto">
              ${history.slice(0, 50).map(h => `
                <div style="display:flex;gap:10px;align-items:center;padding:8px 12px;border:1px solid var(--rule);border-radius:var(--r);background:var(--off2)">
                  <div style="width:6px;height:6px;border-radius:50%;background:var(--purple);flex-shrink:0"></div>
                  <span style="font-size:12px;color:var(--ink2);flex:1">${h.type === 'manual' ? 'Manual run' : 'Triggered run'}${h.ticketId ? ' on ' + h.ticketId : ''}</span>
                  <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${h.triggeredBy || 'System'}</span>
                  <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${h.ts}</span>
                </div>`).join('')}
            </div>
          ` : `<div style="font-size:12px;color:var(--ink3);text-align:center;padding:24px 0">No runs logged yet — use "Run now" to record a manual fire.</div>`}
        </div>
      </div>
    </div>`;
}

function wfFormBody(w) {
  const esc = s => String(s||'').replace(/"/g,'&quot;');
  return `
    <div class="form-row"><label class="form-label">Name</label><input class="form-input" id="wf-name" value="${esc(w?.name)}" placeholder="e.g. Notify on urgent billing"/></div>
    <div class="form-row"><label class="form-label">Trigger</label>
      <input class="form-input" id="wf-trigger" list="wf-trigger-list" value="${esc(w?.trigger)}" placeholder="When this should run"/>
      <datalist id="wf-trigger-list">${WF_TRIGGER_PRESETS.map(t => `<option value="${t}">`).join('')}</datalist>
    </div>
    <div class="form-row"><label class="form-label">Action</label>
      <input class="form-input" id="wf-action" list="wf-action-list" value="${esc(w?.action)}" placeholder="What should happen"/>
      <datalist id="wf-action-list">${WF_ACTION_PRESETS.map(a => `<option value="${a}">`).join('')}</datalist>
    </div>
    <div style="display:flex;align-items:center;gap:10px;padding:6px 0">
      <span style="font-family:'Inter',sans-serif;font-size:11px;font-weight:500;letter-spacing:.04em;text-transform:uppercase;color:var(--ink3)">Active</span>
      <label class="toggle"><input type="checkbox" id="wf-active" ${(!w || w.status==='active')?'checked':''}><span class="toggle-slider"></span></label>
    </div>`;
}

function wfNew() {
  if (!isAdmin()) return;
  showModal('New workflow', wfFormBody(null), () => {
    const name    = document.getElementById('wf-name').value.trim();
    const trigger = document.getElementById('wf-trigger').value.trim();
    const action  = document.getElementById('wf-action').value.trim();
    const active  = document.getElementById('wf-active').checked;
    if (!name || !trigger || !action) return;
    const id = 'WF-' + String(WORKFLOWS.length + 1).padStart(3, '0');
    WORKFLOWS.unshift({ id, name, trigger, action, status: active?'active':'inactive', runCount:0, lastRun:null });
    closeModal(); renderPage('workflows');
  }, 'Create');
}

function wfEdit(id) {
  if (!isAdmin()) return;
  const w = WORKFLOWS.find(x => x.id === id); if (!w) return;
  showModal(`Edit ${w.id}`, wfFormBody(w), () => {
    const name    = document.getElementById('wf-name').value.trim();
    const trigger = document.getElementById('wf-trigger').value.trim();
    const action  = document.getElementById('wf-action').value.trim();
    const active  = document.getElementById('wf-active').checked;
    if (!name || !trigger || !action) return;
    w.name = name; w.trigger = trigger; w.action = action;
    w.status = active ? 'active' : 'inactive';
    closeModal(); renderPage('workflows');
  }, 'Save');
}

function wfDelete(id) {
  if (!isAdmin()) return;
  const w = WORKFLOWS.find(x => x.id === id); if (!w) return;
  showModal('Delete workflow', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${w.name}</strong>? This cannot be undone.</div>`, () => {
    const i = WORKFLOWS.findIndex(x => x.id === id);
    if (i >= 0) WORKFLOWS.splice(i, 1);
    closeModal(); renderPage('workflows');
  }, 'Delete');
}
// ─── Tags ────────────────────────────────────────────────────────────────────
let TAG_FILTER_TYPE = 'all';
let TAG_QUERY = '';
const TAG_SELECTED_NAMES = new Set();
let TAG_SORT_COL = 'count';
let TAG_SORT_DIR = -1;

function renderTags() {
  if (TAG_SELECTED) return renderTagDetail(TAG_SELECTED);
  const admin = isAdmin();
  const list = applyTagFilters();
  const total = TAG_LIBRARY.length;
  const manualN = TAG_LIBRARY.filter(t => t.type === 'manual').length;
  const aiN = TAG_LIBRARY.filter(t => t.type === 'ai').length;
  const aiWithConf = TAG_LIBRARY.filter(t => t.type === 'ai' && t.conf);
  const avgConf = aiWithConf.length ? Math.round(aiWithConf.reduce((a, t) => a + t.conf, 0) / aiWithConf.length) : 0;
  const totalUsage = TAG_LIBRARY.reduce((a, t) => a + t.count, 0);
  const max = Math.max(...TAG_LIBRARY.map(x => x.count), 1);

  const allSelected = list.length > 0 && list.every(t => TAG_SELECTED_NAMES.has(t.tag));
  const sortIndicator = col => TAG_SORT_COL === col ? (TAG_SORT_DIR === 1 ? ' ↑' : ' ↓') : '';

  const rows = list.map(t => {
    const pct = (t.count / max) * 100;
    const confColor = t.conf
      ? (t.conf >= 90 ? 'var(--green)' : t.conf >= 80 ? 'var(--amber)' : 'var(--red)')
      : 'var(--ink4)';
    const checked = TAG_SELECTED_NAMES.has(t.tag);
    return `
      <tr style="cursor:pointer${checked?';background:var(--purple-lt)':''}" onclick="openTagDetail('${escAttr(t.tag)}')">
        <td style="width:32px;padding-right:0" onclick="event.stopPropagation()">
          <input type="checkbox" ${checked?'checked':''} onchange="toggleTagSelected('${escAttr(t.tag)}')" style="cursor:pointer;accent-color:var(--purple)" />
        </td>
        <td><span class="tag tag-neutral" style="font-size:11px">${t.tag}</span></td>
        <td>${t.type === 'ai'
          ? '<span class="tag tag-resolved" style="font-size:10px">AI</span>'
          : '<span class="tag tag-neutral" style="font-size:10px">Manual</span>'}</td>
        <td style="font-family:'DM Mono',monospace;font-size:12px;color:${confColor}">${t.conf ? t.conf + '%' : '—'}</td>
        <td>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="font-family:'DM Mono',monospace;font-size:12px;width:28px;color:var(--ink2)">${t.count}</div>
            <div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden;max-width:160px"><div style="background:var(--purple);height:100%;width:${pct}%"></div></div>
          </div>
        </td>
        ${admin ? `<td style="text-align:right;white-space:nowrap" onclick="event.stopPropagation()">
          <button class="btn btn-sm" onclick="convertTagType('${escAttr(t.tag)}')" title="Convert AI ↔ Manual">${t.type==='ai'?'→ Manual':'→ AI'}</button>
          <button class="btn btn-sm" onclick="mergeTagPrompt('${escAttr(t.tag)}')">Merge</button>
          <button class="btn btn-sm" onclick="tagEdit('${escAttr(t.tag)}')">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="tagDelete('${escAttr(t.tag)}')">Delete</button>
        </td>` : ''}
      </tr>`;
  }).join('');

  const bulkBar = TAG_SELECTED_NAMES.size > 0 ? `
    <div style="padding:8px 20px;border-bottom:1px solid var(--rule);background:var(--purple-lt);display:flex;align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap">
      <span style="font-size:12px;color:var(--purple);font-weight:600">${TAG_SELECTED_NAMES.size} selected</span>
      <select class="filter-select" onchange="bulkSetTagType(this.value)">
        <option value="">Set type…</option>
        <option value="manual">Manual</option>
        <option value="ai">AI-suggested</option>
      </select>
      <button class="btn btn-sm btn-danger" onclick="bulkDeleteTags()">Delete</button>
      <button class="btn btn-sm" onclick="clearTagSelection()" style="margin-left:auto">Clear selection</button>
    </div>` : '';

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Tags</div>
        ${admin
          ? `<button class="btn btn-solid btn-sm" onclick="tagNew()">+ New Tag</button>`
          : `<span style="font-size:11px;color:var(--ink3);font-style:italic">Read-only — admin access required to edit</span>`}
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Total tags</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${manualN}</div><div class="kpi-l">Manual</div></div>
        <div class="kpi"><div class="kpi-n c-green">${aiN}</div><div class="kpi-l">AI-suggested</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${avgConf ? avgConf + '%' : '—'}</div><div class="kpi-l">Avg AI confidence</div></div>
      </div>
      ${bulkBar}
      <div class="filter-bar">
        <span class="filter-label">Filter</span>
        <input class="filter-select" id="tag-search" placeholder="Search tags…" style="width:200px" value="${TAG_QUERY}" oninput="tagSetQuery(this.value)"/>
        <select class="filter-select" onchange="tagSetType(this.value)">
          <option value="all"    ${TAG_FILTER_TYPE==='all'?'selected':''}>All types</option>
          <option value="manual" ${TAG_FILTER_TYPE==='manual'?'selected':''}>Manual</option>
          <option value="ai"     ${TAG_FILTER_TYPE==='ai'?'selected':''}>AI-suggested</option>
        </select>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${total} · ${totalUsage} total uses</span>
      </div>
      <div style="flex:1;overflow-y:auto">
        <table class="tbl">
          <thead><tr>
            <th style="width:32px;padding-right:0" onclick="event.stopPropagation()">
              <input type="checkbox" ${allSelected?'checked':''} onchange="toggleAllTags()" style="cursor:pointer;accent-color:var(--purple)" title="Select all in view"/>
            </th>
            <th onclick="setTagSort('tag')" style="cursor:pointer;user-select:none">Tag${sortIndicator('tag')}</th>
            <th onclick="setTagSort('type')" style="cursor:pointer;user-select:none">Type${sortIndicator('type')}</th>
            <th onclick="setTagSort('conf')" style="cursor:pointer;user-select:none">Confidence${sortIndicator('conf')}</th>
            <th onclick="setTagSort('count')" style="cursor:pointer;user-select:none">Usage${sortIndicator('count')}</th>
            ${admin ? '<th style="text-align:right">Actions</th>' : ''}
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${list.length === 0 ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No tags match</div><div class="empty-line"></div></div>` : ''}
      </div>
    </div>`;
}

function applyTagFilters() {
  let list = [...TAG_LIBRARY];
  if (TAG_FILTER_TYPE !== 'all') list = list.filter(t => t.type === TAG_FILTER_TYPE);
  if (TAG_QUERY.trim()) {
    const q = TAG_QUERY.toLowerCase();
    list = list.filter(t => t.tag.toLowerCase().includes(q));
  }
  list.sort((a, b) => {
    let av = a[TAG_SORT_COL] ?? '', bv = b[TAG_SORT_COL] ?? '';
    if (av == null) av = '';
    if (bv == null) bv = '';
    if (typeof av === 'string') return av.localeCompare(bv) * TAG_SORT_DIR;
    return ((av || 0) - (bv || 0)) * TAG_SORT_DIR;
  });
  return list;
}

function setTagSort(col) {
  if (TAG_SORT_COL === col) TAG_SORT_DIR *= -1;
  else { TAG_SORT_COL = col; TAG_SORT_DIR = col === 'tag' ? 1 : -1; }
  renderPage('tags');
}

function openTagDetail(tag) { TAG_SELECTED = tag; renderPage('tags'); }
function closeTagDetail()   { TAG_SELECTED = null; renderPage('tags'); }

function toggleTagSelected(tag) {
  if (TAG_SELECTED_NAMES.has(tag)) TAG_SELECTED_NAMES.delete(tag);
  else TAG_SELECTED_NAMES.add(tag);
  renderPage('tags');
}
function toggleAllTags() {
  const ids = applyTagFilters().map(t => t.tag);
  const all = ids.length > 0 && ids.every(id => TAG_SELECTED_NAMES.has(id));
  if (all) ids.forEach(id => TAG_SELECTED_NAMES.delete(id));
  else ids.forEach(id => TAG_SELECTED_NAMES.add(id));
  renderPage('tags');
}
function clearTagSelection() { TAG_SELECTED_NAMES.clear(); renderPage('tags'); }

function bulkSetTagType(v) {
  if (!isAdmin() || !v || TAG_SELECTED_NAMES.size === 0) return;
  TAG_LIBRARY.forEach(t => {
    if (TAG_SELECTED_NAMES.has(t.tag)) {
      t.type = v;
      if (v === 'manual') t.conf = null;
      else if (v === 'ai' && !t.conf) t.conf = 90;
    }
  });
  TAG_SELECTED_NAMES.clear();
  renderPage('tags');
}
function bulkDeleteTags() {
  if (!isAdmin()) return;
  const n = TAG_SELECTED_NAMES.size;
  if (n === 0) return;
  showModal(`Delete ${n} tag${n===1?'':'s'}`, `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${n}</strong> tag${n===1?'':'s'}? They will be removed from any tickets currently using them.</div>`, () => {
    [...TAG_SELECTED_NAMES].forEach(tagName => {
      TICKETS.forEach(tk => {
        tk.tags = (tk.tags || []).filter(x => x !== tagName);
        tk.aiTags = (tk.aiTags || []).filter(at => at.tag !== tagName);
      });
      const i = TAG_LIBRARY.findIndex(x => x.tag === tagName);
      if (i >= 0) TAG_LIBRARY.splice(i, 1);
    });
    TAG_SELECTED_NAMES.clear();
    closeModal();
    renderPage('tags');
  }, 'Delete');
}

function convertTagType(tagName) {
  if (!isAdmin()) return;
  const t = TAG_LIBRARY.find(x => x.tag === tagName);
  if (!t) return;
  if (t.type === 'ai') { t.type = 'manual'; t.conf = null; }
  else                 { t.type = 'ai'; t.conf = t.conf || 90; }
  renderPage('tags');
}

function mergeTagPrompt(sourceName) {
  if (!isAdmin()) return;
  const candidates = TAG_LIBRARY.filter(t => t.tag !== sourceName);
  showModal(`Merge "${sourceName}" into…`, `
    <div style="font-size:12px;color:var(--ink3);margin-bottom:12px;line-height:1.5">All tickets using <strong style="color:var(--ink)">${sourceName}</strong> will be re-tagged with the target. The source tag will be deleted.</div>
    <div style="max-height:380px;overflow-y:auto">
      ${candidates.length ? candidates.map(t => `
        <div onmousedown="closeModal();mergeTags('${escAttr(sourceName)}','${escAttr(t.tag)}')" style="padding:9px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;display:flex;gap:10px;align-items:center;background:var(--off2);margin-bottom:6px;transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
          <span class="tag tag-neutral" style="font-size:11px">${t.tag}</span>
          <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);margin-left:auto">${t.count} use${t.count===1?'':'s'}</span>
        </div>`).join('') : '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:18px 0">No other tags to merge into</div>'}
    </div>
  `, null, null);
}

function mergeTags(sourceName, targetName) {
  const source = TAG_LIBRARY.find(x => x.tag === sourceName);
  const target = TAG_LIBRARY.find(x => x.tag === targetName);
  if (!source || !target) return;
  TICKETS.forEach(tk => {
    tk.tags = [...new Set((tk.tags || []).map(x => x === sourceName ? targetName : x))];
    tk.aiTags = (tk.aiTags || []).map(at => at.tag === sourceName ? { ...at, tag: targetName } : at);
  });
  target.count = (target.count || 0) + (source.count || 0);
  const i = TAG_LIBRARY.findIndex(x => x.tag === sourceName);
  if (i >= 0) TAG_LIBRARY.splice(i, 1);
  if (TAG_SELECTED === sourceName) TAG_SELECTED = targetName;
  renderPage('tags');
}

function renderTagDetail(tagName) {
  const t = TAG_LIBRARY.find(x => x.tag === tagName);
  if (!t) { TAG_SELECTED = null; return renderTags(); }
  const admin = isAdmin();
  const using = TICKETS.filter(tk => (tk.tags || []).includes(tagName) || (tk.aiTags || []).some(at => at.tag === tagName));
  const customerIds = new Set(using.map(tk => tk.customerId));

  const byStatus = {};
  using.forEach(tk => byStatus[tk.status] = (byStatus[tk.status] || 0) + 1);
  const byPriority = {};
  using.forEach(tk => byPriority[tk.priority] = (byPriority[tk.priority] || 0) + 1);
  const custCounts = {};
  using.forEach(tk => custCounts[tk.customerId] = (custCounts[tk.customerId] || 0) + 1);
  const topCustomers = Object.entries(custCounts)
    .map(([id, c]) => ({ cust: CUSTOMERS.find(x => x.id === id), count: c }))
    .filter(x => x.cust)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const byBrand = {};
  using.forEach(tk => {
    const cust = CUSTOMERS.find(c => c.id === tk.customerId);
    if (cust) byBrand[cust.brand] = (byBrand[cust.brand] || 0) + 1;
  });

  const statusVals = Object.values(byStatus);
  const statusMax = Math.max(...statusVals, 1);
  const statusBars = Object.entries(byStatus).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
    `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><div style="font-size:11px;color:var(--ink2);width:80px;text-transform:capitalize">${k}</div><div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden"><div style="background:${STATUS_COLORS[k]||'var(--purple)'};height:100%;width:${(v/statusMax)*100}%"></div></div><div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);width:24px;text-align:right">${v}</div></div>`
  ).join('') || '<div style="color:var(--ink3);font-size:12px">No data</div>';

  const priMax = Math.max(...['urgent','high','normal','low'].map(p => byPriority[p] || 0), 1);
  const priBars = ['urgent','high','normal','low'].filter(p => byPriority[p]).map(k => {
    const v = byPriority[k];
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><div style="font-size:11px;color:var(--ink2);width:80px;text-transform:capitalize">${k}</div><div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden"><div style="background:${PRIORITY_COLORS[k]};height:100%;width:${(v/priMax)*100}%"></div></div><div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);width:24px;text-align:right">${v}</div></div>`;
  }).join('') || '<div style="color:var(--ink3);font-size:12px">No data</div>';

  const brandMax = Math.max(...Object.values(byBrand), 1);
  const brandBars = Object.entries(byBrand).sort((a, b) => b[1] - a[1]).map(([brand, count]) =>
    `<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px"><div style="font-size:12px;color:var(--ink2);width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${brand}</div><div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden"><div style="background:var(--purple);height:100%;width:${(count/brandMax)*100}%"></div></div><div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);width:22px;text-align:right">${count}</div></div>`
  ).join('') || '<div style="color:var(--ink3);font-size:12px">No data</div>';

  const topCustRows = topCustomers.length ? topCustomers.map(({ cust, count }) => {
    const max = topCustomers[0].count;
    return `<div onclick="CUSTOMER_SELECTED='${escAttr(cust.id)}';navTo('customers')" style="display:flex;align-items:center;gap:8px;margin-bottom:7px;cursor:pointer">
      <div style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:#fff;flex-shrink:0">${cust.first[0]}${cust.last[0]}</div>
      <div style="font-size:12px;color:var(--ink2);width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${cust.first} ${cust.last}</div>
      <div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden"><div style="background:var(--cyan);height:100%;width:${(count/max)*100}%"></div></div>
      <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);width:22px;text-align:right">${count}</div>
    </div>`;
  }).join('') : '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:8px 0">No customers</div>';

  const ticketRows = using.map(tk => {
    const cust = CUSTOMERS.find(c => c.id === tk.customerId);
    return `<tr onclick="openTicket('${escAttr(tk.id)}')" style="cursor:pointer">
      <td class="bold">${tk.id}</td>
      <td>${cust ? cust.first + ' ' + cust.last : '—'}</td>
      <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${tk.subject}</td>
      <td><span class="tag tag-${tk.status}">${tk.status}</span></td>
      <td><span class="tag tag-${tk.priority}">${tk.priority}</span></td>
      <td>${tk.agent || '—'}</td>
    </tr>`;
  }).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-breadcrumb">
          <span onclick="closeTagDetail()">Tags</span>
          <span class="tb-sep">/</span>
          <span style="color:var(--ink);font-weight:500">${tagName}</span>
          ${admin ? `<span style="margin-left:auto;display:flex;gap:6px">
            <button class="btn btn-sm" onclick="convertTagType('${escAttr(tagName)}')">${t.type==='ai'?'Convert to manual':'Convert to AI'}</button>
            <button class="btn btn-sm" onclick="mergeTagPrompt('${escAttr(tagName)}')">Merge…</button>
            <button class="btn btn-sm" onclick="tagEdit('${escAttr(tagName)}')">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="tagDelete('${escAttr(tagName)}')">Delete</button>
          </span>` : ''}
        </div>
      </div>
      <div class="page-scroll">
        <div class="card" style="display:flex;gap:18px;align-items:center;padding:20px;margin-bottom:16px">
          <div style="width:54px;height:54px;border-radius:var(--r2);background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M3 12L11 4h8v8L11 20l-8-8z" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/><circle cx="15" cy="9" r="1.5" fill="#fff"/></svg>
          </div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap">
              <span class="tag tag-neutral" style="font-size:13px">${tagName}</span>
              ${t.type==='ai' ? '<span class="tag tag-resolved" style="font-size:10px">AI</span>' : '<span class="tag tag-neutral" style="font-size:10px">Manual</span>'}
            </div>
            <div style="font-size:13px;color:var(--ink3)">${t.count} use${t.count===1?'':'s'} · ${customerIds.size} customer${customerIds.size===1?'':'s'}${t.conf ? ' · ' + t.conf + '% confidence' : ''}</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
          <div class="r-tile" style="border-color:rgba(139,92,246,0.3);background:var(--purple-lt)"><div class="r-tile-n" style="color:var(--purple)">${using.length}</div><div class="r-tile-l" style="color:var(--purple)">Tickets</div></div>
          <div class="r-tile" style="border-color:rgba(34,211,238,0.3);background:var(--cyan-lt)"><div class="r-tile-n" style="color:var(--cyan)">${customerIds.size}</div><div class="r-tile-l" style="color:var(--cyan)">Customers</div></div>
          <div class="r-tile"><div class="r-tile-n" style="color:var(--ink);font-size:14px;text-transform:capitalize">${t.type === 'ai' ? 'AI-suggested' : 'Manual'}</div><div class="r-tile-l" style="color:var(--ink3)">Type</div></div>
          <div class="r-tile" style="border-color:rgba(251,191,36,0.3);background:var(--amber-lt)"><div class="r-tile-n" style="color:var(--amber)">${t.conf ? t.conf + '%' : '—'}</div><div class="r-tile-l" style="color:var(--amber)">Confidence</div></div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
          <div class="card"><div class="card-title">By status</div>${statusBars}</div>
          <div class="card"><div class="card-title">By priority</div>${priBars}</div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
          <div class="card"><div class="card-title">Top customers</div>${topCustRows}</div>
          <div class="card"><div class="card-title">By brand</div>${brandBars}</div>
        </div>

        <div class="card">
          <div class="card-title">Tickets using this tag</div>
          ${using.length ? `
            <table class="tbl">
              <thead><tr><th>ID</th><th>Customer</th><th>Subject</th><th>Status</th><th>Priority</th><th>Agent</th></tr></thead>
              <tbody>${ticketRows}</tbody>
            </table>
          ` : '<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No tickets using this tag</div><div class="empty-line"></div></div>'}
        </div>
      </div>
    </div>`;
}

function tagSetType(v) { TAG_FILTER_TYPE = v; renderPage('tags'); }
function tagSetQuery(v) {
  TAG_QUERY = v;
  renderPage('tags');
  const input = document.getElementById('tag-search');
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

function tagShowUsage(tagName) {
  const using = TICKETS.filter(t =>
    (t.tags || []).includes(tagName) ||
    (t.aiTags || []).some(at => at.tag === tagName)
  );
  const def = TAG_LIBRARY.find(t => t.tag === tagName);
  const items = using.length
    ? using.map(t => `
        <div onmousedown="closeModal();openTicket('${escAttr(t.id)}')" style="padding:10px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;display:flex;gap:10px;align-items:center;background:var(--off2);transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
          <span class="tag tag-${t.status}" style="font-size:10px">${t.status}</span>
          <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3)">${t.id}</span>
          <span style="flex:1;font-size:13px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.subject}</span>
        </div>`).join('')
    : '<div style="font-size:12px;color:var(--ink3);text-align:center;padding:24px">No tickets currently use this tag</div>';
  showModal(`Tag: ${tagName}`, `
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--rule)">
      <span class="tag tag-neutral">${tagName}</span>
      ${def ? `<span style="font-size:11px;color:var(--ink3)">${def.type==='ai'?'AI-suggested':'Manual'}${def.conf?` · ${def.conf}% confidence`:''}</span>` : ''}
      <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${using.length} ticket${using.length===1?'':'s'}</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px">${items}</div>
  `, null, null);
}

function tagFormBody(t) {
  const esc = s => String(s||'').replace(/"/g,'&quot;');
  return `
    <div class="form-row"><label class="form-label">Tag name</label><input class="form-input" id="tag-name" value="${esc(t?.tag)}" placeholder="lowercase-with-dashes"/></div>
    <div class="form-row"><label class="form-label">Type</label>
      <select class="form-input" id="tag-type" onchange="document.getElementById('tag-conf-row').style.display = this.value === 'ai' ? 'block' : 'none'">
        <option value="manual" ${(!t || t.type==='manual')?'selected':''}>Manual</option>
        <option value="ai"     ${t?.type==='ai'?'selected':''}>AI-suggested</option>
      </select>
    </div>
    <div class="form-row" id="tag-conf-row" style="display:${t?.type==='ai'?'block':'none'}">
      <label class="form-label">Confidence (%)</label>
      <input class="form-input" id="tag-conf" type="number" min="0" max="100" value="${t?.conf||''}" placeholder="0–100"/>
    </div>`;
}

function normalizeTagName(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function tagNew() {
  if (!isAdmin()) return;
  showModal('New tag', tagFormBody(null), () => {
    const name = normalizeTagName(document.getElementById('tag-name').value);
    const type = document.getElementById('tag-type').value;
    const conf = type === 'ai' ? (parseInt(document.getElementById('tag-conf').value) || null) : null;
    if (!name || TAG_LIBRARY.find(t => t.tag === name)) return;
    TAG_LIBRARY.unshift({ tag: name, count: 0, type, conf });
    closeModal(); renderPage('tags');
  }, 'Create');
}

function tagEdit(name) {
  if (!isAdmin()) return;
  const t = TAG_LIBRARY.find(x => x.tag === name); if (!t) return;
  showModal(`Edit tag`, tagFormBody(t), () => {
    const newName = normalizeTagName(document.getElementById('tag-name').value);
    const type = document.getElementById('tag-type').value;
    const conf = type === 'ai' ? (parseInt(document.getElementById('tag-conf').value) || null) : null;
    if (!newName) return;
    if (newName !== t.tag && TAG_LIBRARY.find(x => x.tag === newName)) return;
    if (newName !== t.tag) {
      TICKETS.forEach(tk => {
        tk.tags = (tk.tags || []).map(x => x === t.tag ? newName : x);
        tk.aiTags = (tk.aiTags || []).map(at => at.tag === t.tag ? { ...at, tag: newName } : at);
      });
    }
    t.tag = newName; t.type = type; t.conf = conf;
    closeModal(); renderPage('tags');
  }, 'Save');
}

function tagDelete(name) {
  if (!isAdmin()) return;
  const t = TAG_LIBRARY.find(x => x.tag === name); if (!t) return;
  const inUse = TICKETS.filter(tk => (tk.tags||[]).includes(name) || (tk.aiTags||[]).some(at => at.tag === name)).length;
  showModal('Delete tag', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${name}</strong>?${inUse?` This tag is currently used by <strong style="color:var(--ink)">${inUse} ticket${inUse===1?'':'s'}</strong> — it will be removed from those tickets.`:''}</div>`, () => {
    TICKETS.forEach(tk => {
      tk.tags = (tk.tags || []).filter(x => x !== name);
      tk.aiTags = (tk.aiTags || []).filter(at => at.tag !== name);
    });
    const i = TAG_LIBRARY.findIndex(x => x.tag === name);
    if (i >= 0) TAG_LIBRARY.splice(i, 1);
    closeModal(); renderPage('tags');
  }, 'Delete');
}
// ─── Roles & Permissions ─────────────────────────────────────────────────────
let ROLES_VIEW_AGENTS = null; // role name → show agents-in-role page; null → matrix

function isAdmin() { return SESSION?.role === 'Admin'; }
function escAttr(s) { return String(s).replace(/'/g, "\\'"); }

function renderRoles() {
  if (ROLES_VIEW_AGENTS) return renderRoleAgentsPage(ROLES_VIEW_AGENTS);
  const roles = Object.keys(ROLES_MATRIX);
  const admin = isAdmin();
  const headerCells = PERMISSIONS.map(p => `<th style="text-align:center;min-width:90px">${p.label}</th>`).join('');
  const rows = roles.map(r => {
    const count = AGENTS.filter(a => a.role === r).length;
    const cells = PERMISSIONS.map(p => {
      const v = !!ROLES_MATRIX[r][p.key];
      const lock = (r === 'Admin' && p.key === 'roles');
      if (admin && !lock) {
        return `<td style="text-align:center"><label class="toggle"><input type="checkbox" ${v?'checked':''} onchange="togglePermission('${escAttr(r)}','${p.key}',this.checked)"><span class="toggle-slider"></span></label></td>`;
      }
      return `<td style="text-align:center;color:${v?'var(--green)':'var(--ink4)'};font-weight:500">${v?'✓':'—'}</td>`;
    }).join('');
    const actions = admin ? `<td style="text-align:right;white-space:nowrap">${r==='Admin' ? '<span style="font-size:11px;color:var(--ink3)">protected</span>' : `<button class="btn btn-sm btn-danger" onclick="deleteRolePrompt('${escAttr(r)}')">Delete</button>`}</td>` : '';
    return `<tr>
      <td class="bold"><span class="link" onclick="openRoleAgents('${escAttr(r)}')">${r}</span></td>
      <td style="text-align:center"><span class="link" onclick="openRoleAgents('${escAttr(r)}')">${count}</span></td>
      ${cells}
      ${actions}
    </tr>`;
  }).join('');
  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Roles & Permissions</div>
        ${admin
          ? `<button class="btn btn-sm" onclick="addPermissionPrompt()">+ Permission</button>
             <button class="btn btn-sm btn-solid" onclick="addRolePrompt()">+ Role</button>`
          : `<span style="font-size:11px;color:var(--ink3);font-style:italic">Read-only — admin access required to edit</span>`}
      </div>
      <div class="page-scroll">
        <div class="card">
          <div class="card-title">Permission Matrix</div>
          <div style="font-size:12px;color:var(--ink3);margin-bottom:12px">Toggle access per role. Click a role name or agent count to see who's in that role.</div>
          <div style="overflow-x:auto">
            <table class="tbl" style="min-width:720px">
              <thead><tr>
                <th style="text-align:left">Role</th>
                <th style="text-align:center">Agents</th>
                ${headerCells}
                ${admin?'<th></th>':''}
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;
}

function renderRoleAgentsPage(role) {
  const list = AGENTS.filter(a => a.role === role);
  const allRoles = Object.keys(ROLES_MATRIX);
  const admin = isAdmin();
  const perms = ROLES_MATRIX[role] || {};

  // Aggregate stats
  const activeN = list.filter(a => a.active).length;
  const totalOpen = list.reduce((sum, a) => sum + TICKETS.filter(t => t.agent === a.name && (t.status === 'open' || t.status === 'escalated')).length, 0);
  const avgLoad = activeN ? (totalOpen / activeN).toFixed(1) : '0';
  const csatScores = [];
  list.forEach(a => TICKETS.forEach(t => { if (t.agent === a.name && t.csat) csatScores.push(t.csat); }));
  const avgCSAT = csatScores.length ? csatScores.reduce((a, b) => a + b, 0) / csatScores.length : 0;
  const granted = PERMISSIONS.filter(p => perms[p.key]);

  // Per-member workload
  const memberLoad = list.map(a => ({
    a,
    open:  TICKETS.filter(t => t.agent === a.name && (t.status === 'open' || t.status === 'escalated')).length,
    total: TICKETS.filter(t => t.agent === a.name).length,
  })).sort((a, b) => b.open - a.open);
  const maxLoad = Math.max(...memberLoad.map(m => m.open), 1);

  const memberRows = list.map(a => {
    const otherRoleOpts = allRoles.map(r => `<option value="${r}" ${a.role===r?'selected':''}>${r}</option>`).join('');
    const open = TICKETS.filter(t => t.agent === a.name && (t.status === 'open' || t.status === 'escalated')).length;
    return `<tr>
      <td>
        <div style="display:flex;align-items:center;gap:8px;cursor:pointer" onclick="openAgentFromDash('${escAttr(a.name)}')">
          <div style="width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;color:#fff;flex-shrink:0;${a.active?'':'opacity:.5'}">${a.initials}</div>
          <span style="font-weight:500;color:var(--ink)">${a.name}</span>
        </div>
      </td>
      <td style="font-family:'DM Mono',monospace;font-size:12px;color:var(--ink2)">${open}</td>
      <td>${admin
        ? `<select class="filter-select" onchange="reassignAgent('${escAttr(a.name)}',this.value)">${otherRoleOpts}</select>`
        : a.role}
      </td>
      <td><span class="tag ${a.active?'tag-resolved':'tag-gdpr'}">${a.active?'Active':'Deactivated'}</span></td>
      ${admin ? `<td style="text-align:right;white-space:nowrap">
        ${a.active
          ? `<button class="btn btn-sm" onclick="setAgentActive('${escAttr(a.name)}',false)">Deactivate</button>`
          : `<button class="btn btn-sm" onclick="setAgentActive('${escAttr(a.name)}',true)">Activate</button>`}
        <button class="btn btn-sm btn-danger" onclick="deleteAgentPrompt('${escAttr(a.name)}')">Delete</button>
      </td>` : ''}
    </tr>`;
  }).join('');

  const permCards = PERMISSIONS.map(p => {
    const v = !!perms[p.key];
    const lock = role === 'Admin' && p.key === 'roles';
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border:1px solid var(--rule);border-radius:var(--r);background:${v?'var(--purple-lt)':'var(--off2)'}">
      <div style="font-size:12.5px;color:${v?'var(--purple)':'var(--ink2)'};font-weight:${v?'500':'400'}">${p.label}</div>
      ${admin && !lock
        ? `<label class="toggle"><input type="checkbox" ${v?'checked':''} onchange="togglePermission('${escAttr(role)}','${p.key}',this.checked);renderPage('roles')"><span class="toggle-slider"></span></label>`
        : `<span style="font-size:11px;color:${v?'var(--green)':'var(--ink4)'};font-family:'DM Mono',monospace">${v?'✓':'—'}</span>`}
    </div>`;
  }).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-breadcrumb">
          <span onclick="closeRoleAgents()">Roles &amp; Permissions</span>
          <span class="tb-sep">/</span>
          <span style="color:var(--ink);font-weight:500">${role}</span>
          ${admin ? `<span style="margin-left:auto;display:flex;gap:6px">
            ${role !== 'Admin' ? `<button class="btn btn-sm" onclick="renameRolePrompt('${escAttr(role)}')">Rename</button>` : ''}
            <button class="btn btn-sm btn-solid" onclick="addAgentToRolePrompt('${escAttr(role)}')">+ Agent</button>
            ${role !== 'Admin' ? `<button class="btn btn-sm btn-danger" onclick="deleteRolePrompt('${escAttr(role)}')">Delete role</button>` : ''}
          </span>` : ''}
        </div>
      </div>
      <div class="page-scroll">
        <div class="card" style="display:flex;gap:18px;align-items:center;padding:20px;margin-bottom:16px">
          <div style="width:54px;height:54px;border-radius:var(--r2);background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6l8-4z" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:20px;font-weight:700;color:var(--ink);letter-spacing:-.02em">${role}</div>
            <div style="font-size:13px;color:var(--ink3);margin-top:6px">${list.length} member${list.length===1?'':'s'} · ${granted.length} of ${PERMISSIONS.length} permissions${role==='Admin'?' · Protected role':''}</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
          <div class="r-tile"><div class="r-tile-n" style="color:var(--ink)">${list.length}</div><div class="r-tile-l" style="color:var(--ink3)">Members</div></div>
          <div class="r-tile" style="border-color:rgba(52,211,153,0.3);background:var(--green-lt)"><div class="r-tile-n" style="color:var(--green)">${activeN}</div><div class="r-tile-l" style="color:var(--green)">Active</div></div>
          <div class="r-tile" style="border-color:rgba(34,211,238,0.3);background:var(--cyan-lt)"><div class="r-tile-n" style="color:var(--cyan)">${avgLoad}</div><div class="r-tile-l" style="color:var(--cyan)">Avg open load</div></div>
          <div class="r-tile" style="border-color:rgba(251,191,36,0.3);background:var(--amber-lt)"><div class="r-tile-n" style="color:var(--amber)">${csatScores.length?avgCSAT.toFixed(1):'—'}</div><div class="r-tile-l" style="color:var(--amber)">Team CSAT</div></div>
        </div>

        <div class="card" style="margin-bottom:16px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
            <div class="card-title" style="margin:0">Permissions</div>
            <span style="font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace">${granted.length} / ${PERMISSIONS.length} granted</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px">
            ${permCards}
          </div>
          ${admin && role === 'Admin' ? '<div style="margin-top:12px;font-size:11px;color:var(--ink3);font-style:italic">The Roles &amp; Perms permission is locked on for the Admin role to prevent self-lockout.</div>' : ''}
        </div>

        ${list.length ? `
        <div class="card" style="margin-bottom:16px">
          <div class="card-title">Workload distribution</div>
          ${memberLoad.map(m => `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px;cursor:pointer" onclick="openAgentFromDash('${escAttr(m.a.name)}')">
              <div style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:#fff;flex-shrink:0;${m.a.active?'':'opacity:.5'}">${m.a.initials}</div>
              <div style="font-size:12px;color:var(--ink2);width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.a.name}</div>
              <div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden"><div style="background:${m.a.active?'var(--purple)':'var(--ink4)'};height:100%;width:${(m.open/maxLoad)*100}%"></div></div>
              <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);width:50px;text-align:right">${m.open} / ${m.total}</div>
            </div>`).join('')}
          <div style="font-size:10px;color:var(--ink3);margin-top:8px;font-family:'DM Mono',monospace">open / total tickets</div>
        </div>` : ''}

        <div class="card">
          <div class="card-title">${list.length} member${list.length===1?'':'s'}</div>
          <table class="tbl">
            <thead><tr>
              <th>Agent</th>
              <th>Open</th>
              <th>Role</th>
              <th>Status</th>
              ${admin?'<th style="text-align:right">Actions</th>':''}
            </tr></thead>
            <tbody>
              ${memberRows}
              ${list.length===0?`<tr><td colspan="${admin?5:4}"><div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No agents in this role</div><div class="empty-line"></div></div></td></tr>`:''}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function renameRolePrompt(oldName) {
  if (!isAdmin() || oldName === 'Admin') return;
  showModal('Rename role', `
    <div class="form-row">
      <label class="form-label">New name</label>
      <input class="form-input" id="rn-name" value="${String(oldName).replace(/"/g,'&quot;')}"/>
    </div>
  `, () => {
    const newName = document.getElementById('rn-name').value.trim();
    if (!newName || newName === oldName) { closeModal(); return; }
    if (ROLES_MATRIX[newName]) return; // duplicate guard
    ROLES_MATRIX[newName] = ROLES_MATRIX[oldName];
    delete ROLES_MATRIX[oldName];
    AGENTS.forEach(a => { if (a.role === oldName) a.role = newName; });
    if (ROLES_VIEW_AGENTS === oldName) ROLES_VIEW_AGENTS = newName;
    closeModal(); renderPage('roles');
  }, 'Rename');
}

function openRoleAgents(role) { ROLES_VIEW_AGENTS = role; renderPage('roles'); }
function closeRoleAgents()    { ROLES_VIEW_AGENTS = null; renderPage('roles'); }

function togglePermission(role, perm, val) {
  if (!isAdmin() || !ROLES_MATRIX[role]) return;
  ROLES_MATRIX[role][perm] = val;
}

function reassignAgent(name, newRole) {
  if (!isAdmin()) return;
  const a = AGENTS.find(x => x.name === name);
  if (a && ROLES_MATRIX[newRole]) a.role = newRole;
  renderPage(CURRENT_PAGE);
}

function setAgentActive(name, active) {
  if (!isAdmin()) return;
  const a = AGENTS.find(x => x.name === name);
  if (a) a.active = active;
  renderPage(CURRENT_PAGE);
}

function deleteAgentPrompt(name) {
  if (!isAdmin()) return;
  showModal('Delete agent', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently remove <strong style="color:var(--ink)">${name}</strong>? Tickets currently assigned to them will keep the historical assignment.</div>`, () => {
    const i = AGENTS.findIndex(a => a.name === name);
    if (i >= 0) AGENTS.splice(i, 1);
    if (AGENT_SELECTED === name) AGENT_SELECTED = null;
    closeModal(); renderPage(CURRENT_PAGE);
  }, 'Delete');
}

function addAgentToRolePrompt(role) {
  if (!isAdmin()) return;
  showModal(`Add agent to ${role}`, `
    <div class="form-grid">
      <div class="form-row"><label class="form-label">Full name</label><input class="form-input" id="ar-name" placeholder="Jane Doe"/></div>
      <div class="form-row"><label class="form-label">Initials</label><input class="form-input" id="ar-init" placeholder="JD" maxlength="3"/></div>
    </div>
  `, () => {
    const name = document.getElementById('ar-name').value.trim();
    let init = document.getElementById('ar-init').value.trim().toUpperCase();
    if (!name || AGENTS.find(a => a.name === name)) return;
    if (!init) init = name.split(/\s+/).map(w=>w[0]).join('').slice(0,2).toUpperCase();
    AGENTS.push({name, initials:init, role, active:true});
    closeModal(); renderPage('roles');
  }, 'Add');
}

function addRolePrompt() {
  if (!isAdmin()) return;
  showModal('New role', `
    <div class="form-row"><label class="form-label">Role name</label><input class="form-input" id="nr-name" placeholder="e.g. Compliance Officer"/></div>
    <div class="form-row"><label class="form-label">Copy permissions from</label>
      <select class="form-input" id="nr-base">
        <option value="">Start with no permissions</option>
        ${Object.keys(ROLES_MATRIX).map(r => `<option value="${r}">${r}</option>`).join('')}
      </select>
    </div>
  `, () => {
    const name = document.getElementById('nr-name').value.trim();
    if (!name || ROLES_MATRIX[name]) return;
    const base = document.getElementById('nr-base').value;
    const perms = {};
    PERMISSIONS.forEach(p => { perms[p.key] = base ? !!ROLES_MATRIX[base][p.key] : false; });
    ROLES_MATRIX[name] = perms;
    closeModal(); renderPage('roles');
  }, 'Create');
}

function addPermissionPrompt() {
  if (!isAdmin()) return;
  showModal('New permission', `
    <div class="form-row"><label class="form-label">Display label</label><input class="form-input" id="np-label" placeholder="e.g. Billing Refunds"/></div>
    <div class="form-row"><label class="form-label">Internal key</label><input class="form-input" id="np-key" placeholder="auto-generated from label if blank"/></div>
  `, () => {
    let label = document.getElementById('np-label').value.trim();
    let key = document.getElementById('np-key').value.trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
    if (!key && label) key = label.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
    if (!label) label = key;
    if (!key || PERMISSIONS.find(p => p.key === key)) return;
    PERMISSIONS.push({key, label});
    Object.keys(ROLES_MATRIX).forEach(r => { if (ROLES_MATRIX[r][key] === undefined) ROLES_MATRIX[r][key] = false; });
    closeModal(); renderPage('roles');
  }, 'Add');
}

function deleteRolePrompt(role) {
  if (!isAdmin() || role === 'Admin') return;
  const inUse = AGENTS.filter(a => a.role === role).length;
  if (inUse > 0) {
    showModal('Cannot delete role', `<div style="font-size:13px;color:var(--ink2);line-height:1.6"><strong style="color:var(--ink)">${inUse}</strong> agent${inUse===1?' is':'s are'} still assigned to <strong style="color:var(--ink)">${role}</strong>. Reassign them to another role first.</div>`, null, null);
    return;
  }
  showModal('Delete role', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete the <strong style="color:var(--ink)">${role}</strong> role?</div>`, () => {
    delete ROLES_MATRIX[role];
    closeModal(); renderPage('roles');
  }, 'Delete');
}
function drawReportCharts() {}

// ─── Auth helpers ────────────────────────────────────────────────────────────
function showAuthPanel(panel) {
  ['login','forgot','create'].forEach(p => {
    const el = document.getElementById('auth-'+p);
    if (el) el.style.display = p === panel ? 'block' : 'none';
  });
  // Clear stale error/confirmation messages
  ['login-error','create-error','create-confirm','forgot-confirm'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  });
}

function isValidEmail(e) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); }

function togglePassword(id) {
  const el = document.getElementById(id); if (!el) return;
  el.type = el.type === 'password' ? 'text' : 'password';
}

function ssoLogin(provider) {
  const presets = {
    google:    { name: 'Sofia Reyes',  initials: 'SR', role: 'Senior Agent' },
    microsoft: { name: 'James Webb',   initials: 'JW', role: 'Senior Agent' },
    saml:      { name: 'Emma Clarke',  initials: 'EC', role: 'Admin' },
  };
  const p = presets[provider] || presets.saml;
  login(p.role, p.name, p.initials);
}

function deriveNameFromEmail(email) {
  const local = email.split('@')[0];
  const parts = local.split(/[._-]/).filter(Boolean);
  const cap = w => w ? w[0].toUpperCase() + w.slice(1) : '';
  const first = cap(parts[0]) || 'User';
  const last  = cap(parts[1]) || '';
  return { name: (first + ' ' + last).trim(), initials: ((first[0]||'') + (last[0]||'')).toUpperCase() || first[0] };
}

function submitLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pw    = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.style.display = 'none';
  if (!email || !pw) { errEl.textContent = 'Please enter your email and password.'; errEl.style.display = 'block'; return; }
  if (!isValidEmail(email)) { errEl.textContent = 'Please enter a valid email.'; errEl.style.display = 'block'; return; }
  if (pw.length < 6) { errEl.textContent = 'Invalid email or password.'; errEl.style.display = 'block'; return; }
  const { name, initials } = deriveNameFromEmail(email);
  login('Senior Agent', name, initials);
}

function submitForgot() {
  const email = document.getElementById('forgot-email')?.value.trim() || '';
  const c = document.getElementById('forgot-confirm');
  if (!isValidEmail(email)) {
    if (c) { c.textContent = 'Please enter a valid email address.'; c.style.color = 'var(--red)'; c.style.display = 'block'; }
    return;
  }
  if (c) { c.textContent = 'Reset link sent — check your inbox.'; c.style.color = 'var(--green)'; c.style.display = 'block'; }
}

function pwScore(pw) {
  let s = 0;
  if (!pw) return 0;
  if (pw.length >= 8)  s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return s;
}

function updatePwStrength(pw) {
  const wrap = document.getElementById('pw-strength-wrap');
  const bar  = document.getElementById('pw-strength-bar');
  const text = document.getElementById('pw-strength-text');
  if (!wrap || !bar || !text) return;
  if (!pw) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  const score = pwScore(pw);
  const labels = ['Very weak','Weak','Fair','Good','Strong','Very strong'];
  const colors = ['var(--red)','var(--red)','var(--amber)','var(--amber)','var(--green)','var(--green)'];
  bar.style.width = (score / 5) * 100 + '%';
  bar.style.background = colors[score];
  text.textContent = labels[score];
  text.style.color = colors[score];
}

function submitCreate() {
  const first = document.getElementById('ca-first').value.trim();
  const last  = document.getElementById('ca-last').value.trim();
  const email = document.getElementById('ca-email').value.trim();
  const pw    = document.getElementById('ca-password').value;
  const terms = document.getElementById('ca-terms').checked;
  const errEl = document.getElementById('create-error');
  const okEl  = document.getElementById('create-confirm');
  errEl.style.display = 'none';
  okEl.style.display = 'none';
  if (!first || !last)         { errEl.textContent = 'Please enter your first and last name.'; errEl.style.display = 'block'; return; }
  if (!isValidEmail(email))    { errEl.textContent = 'Please enter a valid work email.';      errEl.style.display = 'block'; return; }
  if (pwScore(pw) < 3)         { errEl.textContent = 'Password is too weak — aim for "Good" or higher.'; errEl.style.display = 'block'; return; }
  if (!terms)                  { errEl.textContent = 'Please accept the terms.';              errEl.style.display = 'block'; return; }
  okEl.style.display = 'block';
}

// ─── Modal/panel stubs (referenced by inline onclick) ────────────────────────
function showMacroPanel(id) {
  const items = CANNED_RESPONSES.map((r, i) => {
    const preview = r.text.replace(/\n+/g, ' ').slice(0, 100);
    return `<div class="macro-item" onclick="insertMacro('${escAttr(id)}',${i})">
      <div style="display:flex;flex-direction:column;gap:3px;flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--ink)">${r.name}</div>
        <div style="font-size:11px;color:var(--ink3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${preview}</div>
      </div>
    </div>`;
  }).join('');
  showModal('Insert canned response', `<div style="font-size:12px;color:var(--ink3);margin-bottom:12px">{name} placeholders are auto-filled with the customer\'s first name.</div>${items}`, null, null);
}

function showGDPRModal(id) {
  showModal('GDPR actions', `
    <div class="gdpr-action"><div class="gdpr-action-title">Request erasure</div><div class="gdpr-action-desc">Permanently delete this customer's personal data under Article 17.</div><button class="btn btn-sm btn-danger" onclick="closeModal()">Request erasure</button></div>
    <div class="gdpr-action"><div class="gdpr-action-title">Redact in-thread data</div><div class="gdpr-action-desc">Mask PII in this ticket's messages.</div><button class="btn btn-sm" onclick="closeModal()">Redact</button></div>
    <div class="gdpr-action"><div class="gdpr-action-title">SAR export</div><div class="gdpr-action-desc">Export all data held about this customer.</div><button class="btn btn-sm" onclick="closeModal()">Export</button></div>
  `, null, null);
}
function openCustomerModal(custId) {
  const c = CUSTOMERS.find(x => x.id === custId); if (!c) return;
  showModal(`${c.first} ${c.last}`, `
    <div class="ts-row"><span class="ts-key">Customer ID</span><span class="ts-val">${c.id}</span></div>
    <div class="ts-row"><span class="ts-key">Email</span><span class="ts-val">${c.email}</span></div>
    <div class="ts-row"><span class="ts-key">Mobile</span><span class="ts-val">${c.mobile}</span></div>
    <div class="ts-row"><span class="ts-key">Brand</span><span class="ts-val">${c.brand}</span></div>
    <div class="ts-row"><span class="ts-key">VIP</span><span class="vip-badge vip-${c.vip.toLowerCase()}">${c.vip}</span></div>
    <div class="ts-row"><span class="ts-key">Jurisdiction</span><span class="ts-val">${c.jurisdiction}</span></div>
    <div class="ts-row"><span class="ts-key">KYC</span><span class="ts-val">${c.kyc}</span></div>
    <div class="ts-row"><span class="ts-key">Customer since</span><span class="ts-val">${c.since}</span></div>
  `, null, null);
}
function showCSVModal() {
  showModal('CSV import', `<div class="attach-zone">Drop a CSV file or click to upload</div><div style="font-size:11px;color:var(--ink3);margin-top:10px">Expected columns: id, first, last, email, brand, vip, jurisdiction</div>`, () => closeModal(), 'Import');
}
// ─── Layouts ─────────────────────────────────────────────────────────────────
// Drives which fields appear (and which are required) on the new-ticket and
// new-customer forms, and on the customer-detail Profile card. Locked fields
// are key info that the schema can't function without — we still render them
// in the UI but disable the Required toggle so admins can't accidentally
// turn off something the rest of the app depends on.
const FIELD_LAYOUTS = {
  ticket: [
    { key:'subject',    label:'Subject',          locked:true,  required:true,  visible:true },
    { key:'customerId', label:'Customer',         locked:true,  required:true,  visible:true },
    { key:'category',   label:'Category',         locked:false, required:false, visible:true },
    { key:'priority',   label:'Priority',         locked:false, required:false, visible:true },
    { key:'agent',      label:'Assignee',         locked:false, required:false, visible:true },
    { key:'message',    label:'First message',    locked:false, required:false, visible:true },
    { key:'tags',       label:'Tags',             locked:false, required:false, visible:true },
  ],
  customer: [
    { key:'first',        label:'First name',     locked:true,  required:true,  visible:true },
    { key:'last',         label:'Last name',      locked:true,  required:true,  visible:true },
    { key:'email',        label:'Email',          locked:false, required:true,  visible:true },
    { key:'mobile',       label:'Mobile',         locked:false, required:false, visible:true },
    { key:'username',     label:'Username',       locked:false, required:false, visible:true },
    { key:'brand',        label:'Brand',          locked:false, required:false, visible:true },
    { key:'vip',          label:'VIP tier',       locked:false, required:false, visible:true },
    { key:'jurisdiction', label:'Jurisdiction',   locked:false, required:false, visible:true },
    { key:'kyc',          label:'KYC status',     locked:false, required:false, visible:true },
    { key:'since',        label:'Customer since', locked:false, required:false, visible:true },
  ],
};

function getLayoutField(entity, key) {
  return (FIELD_LAYOUTS[entity] || []).find(f => f.key === key);
}
function isFieldVisible(entity, key) {
  const f = getLayoutField(entity, key);
  return !f || f.visible !== false;
}
function isFieldRequired(entity, key) {
  const f = getLayoutField(entity, key);
  return f ? !!f.required : false;
}

function setLayoutFieldFlag(entity, key, flag, val) {
  const f = getLayoutField(entity, key);
  if (!f || f.locked) return;
  // Locked fields must stay required + visible; non-locked fields can flip
  // both flags freely. Marking a field invisible also implies non-required —
  // a hidden field can't be required without a way for the agent to fill it.
  f[flag] = !!val;
  if (flag === 'visible' && !f.visible) f.required = false;
  if (flag === 'required' && f.required) f.visible = true;
  renderPage('layouts');
}

function renderLayouts() {
  const admin = isAdmin();
  const tab = LAYOUTS_TAB;
  const fields = FIELD_LAYOUTS[tab] || [];
  const visN = fields.filter(f => f.visible).length;
  const reqN = fields.filter(f => f.required).length;
  const lockedN = fields.filter(f => f.locked).length;

  const rows = fields.map(f => `
    <tr>
      <td>
        <strong style="color:var(--ink)">${escHtml(f.label)}</strong>
        ${f.locked ? '<span style="margin-left:8px;font-family:\'DM Mono\',monospace;font-size:10px;color:var(--ink3);background:var(--off2);padding:1px 6px;border-radius:3px">key</span>' : ''}
        <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);margin-top:2px">${escHtml(f.key)}</div>
      </td>
      <td style="text-align:center">
        <label class="toggle">
          <input type="checkbox" ${f.required?'checked':''} ${(!admin || f.locked)?'disabled':''} onchange="setLayoutFieldFlag('${escAttr(tab)}','${escAttr(f.key)}','required',this.checked)">
          <span class="toggle-slider"></span>
        </label>
        ${f.locked ? '<div style="font-size:10px;color:var(--ink3);margin-top:2px;font-style:italic">locked</div>' : ''}
      </td>
      <td style="text-align:center">
        <label class="toggle">
          <input type="checkbox" ${f.visible?'checked':''} ${(!admin || f.locked)?'disabled':''} onchange="setLayoutFieldFlag('${escAttr(tab)}','${escAttr(f.key)}','visible',this.checked)">
          <span class="toggle-slider"></span>
        </label>
        ${f.locked ? '<div style="font-size:10px;color:var(--ink3);margin-top:2px;font-style:italic">locked</div>' : ''}
      </td>
    </tr>`).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Layouts</div>
        <span style="font-size:11px;color:var(--ink3);font-style:italic">${admin ? 'Toggle each field as required or visible. Key fields stay locked so the rest of the app keeps working.' : 'Read-only — admin access required to edit'}</span>
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${fields.length}</div><div class="kpi-l">Fields</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${visN}</div><div class="kpi-l">Visible</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${reqN}</div><div class="kpi-l">Required</div></div>
        <div class="kpi"><div class="kpi-n">${lockedN}</div><div class="kpi-l">Locked</div></div>
      </div>
      <div class="filter-bar">
        <span class="filter-label">Apply to</span>
        <span class="filter-tag" style="cursor:pointer;${tab==='ticket'?'border-color:var(--purple);color:var(--purple);background:var(--purple-lt)':''}" onclick="LAYOUTS_TAB='ticket';renderPage('layouts')">Tickets</span>
        <span class="filter-tag" style="cursor:pointer;${tab==='customer'?'border-color:var(--purple);color:var(--purple);background:var(--purple-lt)':''}" onclick="LAYOUTS_TAB='customer';renderPage('layouts')">Customers</span>
      </div>
      <div class="page-scroll">
        <table class="tbl">
          <thead><tr><th>Field</th><th style="text-align:center;width:120px">Required</th><th style="text-align:center;width:120px">Visible</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div style="margin-top:14px;font-size:11px;color:var(--ink3);line-height:1.5;padding:0 4px">Hidden fields are dropped from the new-${tab} form and the ${tab === 'ticket' ? 'ticket sidebar' : 'customer profile card'}. Required fields validate on submit. Marking a field hidden also clears its required flag — a hidden field with no input path would be unfillable.</div>
      </div>
    </div>`;
}

// ─── Custom Fields manager ───────────────────────────────────────────────────

const CF_TYPES = [
  { v:'text',    l:'Text' },
  { v:'number',  l:'Number' },
  { v:'date',    l:'Date' },
  { v:'select',  l:'Select (single)' },
  { v:'boolean', l:'Boolean (yes/no)' },
];

function renderCustomFields() {
  const admin = isAdmin();
  let list = [...CUSTOM_FIELDS];
  if (CF_FILTER_ENTITY !== 'all') list = list.filter(f => (f.entity || 'customer') === CF_FILTER_ENTITY);
  const total = CUSTOM_FIELDS.length;
  const byType = {};
  CUSTOM_FIELDS.forEach(f => { byType[f.type] = (byType[f.type] || 0) + 1; });

  const rows = list.map(f => {
    const entity = f.entity || 'customer';
    const def = f.defaultValue ?? '';
    return `<tr>
      <td class="bold">${f.id}</td>
      <td style="font-weight:500;color:var(--ink)">${escHtml(f.label)}</td>
      <td><span class="tag tag-neutral" style="font-size:10px;text-transform:capitalize">${escHtml(f.type)}</span></td>
      <td><span class="tag tag-neutral" style="font-size:10px;text-transform:capitalize">${entity}</span></td>
      <td style="font-size:12px;color:var(--ink2);font-family:'DM Mono',monospace">${def !== '' ? escHtml(String(def)) : '—'}</td>
      <td style="text-align:center">${f.required ? '<span class="tag tag-gdpr" style="font-size:10px">required</span>' : '<span style="color:var(--ink4);font-size:11px">—</span>'}</td>
      ${admin ? `<td style="text-align:right;white-space:nowrap">
        <button class="btn btn-sm" onclick="cfEdit('${escAttr(f.id)}')">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="cfDelete('${escAttr(f.id)}')">Delete</button>
      </td>` : ''}
    </tr>`;
  }).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Custom Fields</div>
        ${admin ? `<button class="btn btn-solid btn-sm" onclick="cfNew()">+ New Field</button>` : `<span style="font-size:11px;color:var(--ink3);font-style:italic">Read-only</span>`}
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Fields</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${CUSTOM_FIELDS.filter(f => (f.entity||'customer') === 'customer').length}</div><div class="kpi-l">On customers</div></div>
        <div class="kpi"><div class="kpi-n c-purple">${CUSTOM_FIELDS.filter(f => (f.entity||'customer') === 'ticket').length}</div><div class="kpi-l">On tickets</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${CUSTOM_FIELDS.filter(f => f.required).length}</div><div class="kpi-l">Required</div></div>
      </div>
      <div class="filter-bar">
        <span class="filter-label">Entity</span>
        <select class="filter-select" onchange="CF_FILTER_ENTITY=this.value;renderPage('custom-fields')">
          <option value="all"      ${CF_FILTER_ENTITY==='all'?'selected':''}>All entities</option>
          <option value="customer" ${CF_FILTER_ENTITY==='customer'?'selected':''}>Customer fields</option>
          <option value="ticket"   ${CF_FILTER_ENTITY==='ticket'?'selected':''}>Ticket fields</option>
        </select>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${total}</span>
      </div>
      <div class="page-scroll">
        <table class="tbl">
          <thead><tr><th>ID</th><th>Label</th><th>Type</th><th>Entity</th><th>Default</th><th style="text-align:center">Required</th>${admin?'<th style="text-align:right">Actions</th>':''}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${list.length===0 ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No custom fields defined</div><div class="empty-line"></div></div>` : ''}
        <div style="margin-top:14px;font-size:11px;color:var(--ink3);line-height:1.5">Customer fields render in the customer detail page (Custom fields card). Ticket fields are reserved for future ticket-detail integration. Select fields use a comma-separated <code style="font-family:'DM Mono',monospace;font-size:11px">options</code> list captured at edit time.</div>
      </div>
    </div>`;
}

function cfFormBody(f) {
  const esc = s => String(s||'').replace(/"/g,'&quot;');
  const optsCsv = f && Array.isArray(f.options) ? f.options.join(', ') : '';
  return `
    <div class="form-grid">
      <div class="form-row"><label class="form-label">Label</label><input class="form-input" id="cf-label" value="${esc(f?.label)}" placeholder="e.g. Renewal Date"/></div>
      <div class="form-row"><label class="form-label">Type</label>
        <select class="form-input" id="cf-type" onchange="cfFormToggleOptions(this.value)">
          ${CF_TYPES.map(t => `<option value="${t.v}" ${(f?.type||'text')===t.v?'selected':''}>${t.l}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label class="form-label">Entity</label>
        <select class="form-input" id="cf-entity">
          <option value="customer" ${(f?.entity||'customer')==='customer'?'selected':''}>Customer</option>
          <option value="ticket"   ${f?.entity==='ticket'?'selected':''}>Ticket</option>
        </select>
      </div>
      <div class="form-row"><label class="form-label">Default value</label><input class="form-input" id="cf-default" value="${esc(f?.defaultValue)}" placeholder="optional"/></div>
    </div>
    <div class="form-row" id="cf-options-row" style="display:${f?.type==='select'?'block':'none'}">
      <label class="form-label">Options (comma-separated)</label>
      <input class="form-input" id="cf-options" value="${esc(optsCsv)}" placeholder="e.g. Bronze, Silver, Gold, Platinum"/>
    </div>
    <div style="display:flex;align-items:center;gap:10px;padding:6px 0">
      <span style="font-family:'Inter',sans-serif;font-size:11px;font-weight:500;letter-spacing:.04em;text-transform:uppercase;color:var(--ink3)">Required</span>
      <label class="toggle"><input type="checkbox" id="cf-required" ${f?.required?'checked':''}><span class="toggle-slider"></span></label>
    </div>`;
}

function cfFormToggleOptions(type) {
  const row = document.getElementById('cf-options-row');
  if (row) row.style.display = type === 'select' ? 'block' : 'none';
}

function cfReadForm() {
  const label = document.getElementById('cf-label').value.trim();
  const type = document.getElementById('cf-type').value;
  const entity = document.getElementById('cf-entity').value;
  const defaultValue = document.getElementById('cf-default').value;
  const required = document.getElementById('cf-required').checked;
  const options = type === 'select'
    ? document.getElementById('cf-options').value.split(',').map(s => s.trim()).filter(Boolean)
    : undefined;
  return { label, type, entity, defaultValue, required, options };
}

function cfNextId() {
  const max = Math.max(0, ...CUSTOM_FIELDS.map(x => parseInt((x.id || '').replace(/^cf/i, ''), 10) || 0));
  return 'cf' + (max + 1);
}

function cfNew() {
  if (!isAdmin()) return;
  showModal('New custom field', cfFormBody(null), () => {
    const data = cfReadForm();
    if (!data.label) return;
    const field = { id: cfNextId(), label: data.label, type: data.type, entity: data.entity, required: data.required, defaultValue: data.defaultValue };
    if (data.options) field.options = data.options;
    CUSTOM_FIELDS.unshift(field);
    closeModal(); renderPage('custom-fields');
  }, 'Create');
}

function cfEdit(id) {
  if (!isAdmin()) return;
  const f = CUSTOM_FIELDS.find(x => x.id === id); if (!f) return;
  showModal(`Edit ${f.id}`, cfFormBody(f), () => {
    const data = cfReadForm();
    if (!data.label) return;
    f.label = data.label; f.type = data.type; f.entity = data.entity;
    f.required = data.required; f.defaultValue = data.defaultValue;
    if (data.options) f.options = data.options; else delete f.options;
    closeModal(); renderPage('custom-fields');
  }, 'Save');
}

function cfDelete(id) {
  if (!isAdmin()) return;
  const f = CUSTOM_FIELDS.find(x => x.id === id); if (!f) return;
  showModal('Delete custom field', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${escHtml(f.label)}</strong>? Existing values stored on customer / ticket records will become orphaned (not deleted).</div>`, () => {
    const i = CUSTOM_FIELDS.findIndex(x => x.id === id);
    if (i >= 0) CUSTOM_FIELDS.splice(i, 1);
    closeModal(); renderPage('custom-fields');
  }, 'Delete');
}

function showManageFieldsModal() {
  showModal('Manage custom fields', `
    ${CUSTOM_FIELDS.map(f => `<div class="ts-row"><span class="ts-key">${f.label}</span><span class="ts-val">${f.type}</span></div>`).join('')}
    <div style="font-size:11px;color:var(--ink3);margin-top:14px">Custom fields appear as toggleable columns in the customer table.</div>
  `, null, null);
}
function showNewCustomerModal() {
  showModal('New customer', `
    <div class="form-grid">
      <div class="form-row"><label class="form-label">First name</label><input class="form-input" id="nc-first"/></div>
      <div class="form-row"><label class="form-label">Last name</label><input class="form-input" id="nc-last"/></div>
    </div>
    <div class="form-row"><label class="form-label">Email</label><input class="form-input" id="nc-email" type="email"/></div>
    <div class="form-row"><label class="form-label">Brand</label><input class="form-input" id="nc-brand"/></div>
  `, () => {
    const first = document.getElementById('nc-first').value.trim();
    const last  = document.getElementById('nc-last').value.trim();
    if (!first || !last) return;
    const id = 'M' + String(CUSTOMERS.length + 1).padStart(3,'0');
    CUSTOMERS.push({id,first,last,username:(first[0]+last).toLowerCase(),email:document.getElementById('nc-email').value,mobile:'',brand:document.getElementById('nc-brand').value,vip:'Bronze',jurisdiction:'UK',consent:true,kyc:'Pending',since:new Date().toISOString().slice(0,10),bo:'',custom:{}});
    closeModal(); refreshCustTable(CUSTOMERS);
  }, 'Create');
}

// ─── Window bridge ─────────────────────────────────────────────────────────────
// Re-exposes module-scope functions onto window. Two reasons an entry exists:
//
//   1. The function is called from an inline HTML attribute handler
//      (onclick="foo()"). Those handlers look up identifiers via the window
//      scope chain, which does not see ES-module-scoped declarations.
//
//   2. The function is a utility (showModal, escHtml, …) called from
//      already-extracted feature modules via `window.X()` while it still
//      lives in app.js. Each one gets a proper import once the owning
//      module is also extracted.
//
// The initial list was generated from `comm -12 handler-calls top-level-fns`.
// Entries get deleted as functions move into per-feature modules; cross-
// module entries get deleted as their owners are also modularised.
Object.assign(window, {
  acceptAITag,
  acceptAllAITags,
  actGotoEntity,
  actSetQuery,
  addAgentToRolePrompt,
  addCustomerNote,
  addMockAttachment,
  addPermissionPrompt,
  addRolePrompt,
  agentNew,
  agentSetQuery,
  agentSetRole,
  agentSetStatus,
  aiAction,
  aiClear,
  aiInputKey,
  aiSend,
  aiToggleSource,
  aiUsePrompt,
  arDelete,
  arEdit,
  arModeChanged,
  arNew,
  arToggle,
  bhAddHoliday,
  bhRemoveHoliday,
  bhSetDayEnabled,
  bhSetDayTime,
  bhSetEnabled,
  bulkAddTag,
  bulkApplyAssignmentRules,
  bulkAssignTickets,
  bulkDeleteCustomers,
  bulkDeleteTags,
  bulkDeleteTickets,
  bulkExportTickets,
  bulkRunMacro,
  bulkSetCustConsent,
  bulkSetCustVIP,
  bulkSetPriority,
  bulkSetStatus,
  bulkSetTagType,
  bulkSnoozeTickets,
  cfDelete,
  cfEdit,
  cfFormToggleOptions,
  cfNew,
  chDelete,
  chEdit,
  chNew,
  chToggle,
  changeTicketAgent,
  changeTicketPriority,
  changeTicketStatus,
  clearAgentOOO,
  clearAllNotifications,
  clearCustSelection,
  clearTagSelection,
  clearTicketSelection,
  clearTicketSummary,
  closeAgentDetail,
  closeCustomerProfile,
  closeKBArticle,
  addTicketTag,
  applyAssignmentRules,
  buildKbQuery,
  closeModal,
  deleteAIConv,
  escAttr,
  escHtml,
  fetchKbArticles,
  fireWebhook,
  fmtMinutes,
  hideMentionDropdown,
  hideWidgetById,
  isAdmin,
  linkTickets,
  logTicketEvent,
  mentionDropdownKey,
  mergeCustomers,
  mergeTags,
  mergeTickets,
  refreshCustTable,
  refreshNotifBadge,
  refreshTicketSLA,
  removeTicketTag,
  runMacro,
  showModal,
  showWidgetById,
  showWidgetMenu,
  snoozePresetIso,
  ticketPayload,
  updateNavBadges,
  closeNotifAndGo,
  closeRoleAgents,
  closeTagDetail,
  closeWfDetail,
  convertEmailToTicket,
  convertTagType,
  copyAIMessage,
  copyTxResult,
  csatHover,
  csatPick,
  custSetBrand,
  custSetVIP,
  deleteAgentPrompt,
  deleteCustomerNote,
  deleteRolePrompt,
  dismissEmail,
  dismissNotif,
  dropCustCol,
  duplicateWf,
  exportCustomerList,
  exportReport,
  exportTicketList,
  filterCustomers,
  globalSearch,
  gsGo,
  gsKey,
  gsOpenAllResults,
  hideMessageTranslation,
  insertMacro,
  insertMention,
  insertVar,
  kbDeleteArticle,
  kbEditArticle,
  kbNewArticle,
  kbSetCat,
  kbSetQuery,
  login,
  logout,
  macAddStep,
  macDelete,
  macEdit,
  macNew,
  macRemoveStep,
  macStepKindChange,
  markAllNotifRead,
  markAllNotifReadAndRender,
  markNotifRead,
  markSpamEmail,
  mergeTagPrompt,
  nav,
  navTo,
  newAIConv,
  notifPageSetRead,
  notifPageSetType,
  ntApplyTemplate,
  onComposeInput,
  openAgentDetail,
  openAgentFromDash,
  openCSATSurveyModal,
  openChannel,
  openCustomerModal,
  openCustomerProfile,
  openKBArticle,
  openKBFromDash,
  openNotification,
  openNotificationFromPage,
  openRoleAgents,
  openTagDetail,
  openTicket,
  openWfDetail,
  portalCreateTicket,
  portalExit,
  portalNav,
  portalOpenTicket,
  portalSendReply,
  portalSetCustomer,
  prevNextTicket,
  profileMenuGo,
  qsSetActive,
  quickStatus,
  quickSwitcherInput,
  quickSwitcherKey,
  quickSwitcherPick,
  reassignAgent,
  refreshTicketKbSuggestions,
  removeAttachment,
  removeTimeEntry,
  renameRolePrompt,
  renderPage,
  requestCSAT,
  resetAllCollapsedSections,
  resetWidgetLayout,
  restoreEmail,
  runAssignmentRulesOnTicket,
  runTranslator,
  searchPageSetQuery,
  selectAIConv,
  sendCompose,
  sendComposeAnd,
  setAIKey,
  setAIModel,
  setAgentActive,
  setAgentFilter,
  setAgentPreferredLang,
  setComposeTab,
  setCustGroupBy,
  setCustView,
  setCustomerLanguage,
  setKbCfg,
  setLayoutFieldFlag,
  setReportTF,
  setSettingsTab,
  setStatusFilter,
  setTagSort,
  setTheme,
  setTicketGroupBy,
  setTicketQuery,
  setTicketView,
  setWidgetChart,
  showAgentOOOModal,
  showApplyMacroModal,
  showAttachPanel,
  showAuthPanel,
  showCSVModal,
  showColumnPanel,
  showCustomerGDPR,
  showGDPRModal,
  showLinkTicketModal,
  showLogTimeModal,
  showMacroPanel,
  showManageFieldsModal,
  showManageWidgetsModal,
  showMergeCustomerModal,
  showMergeTicketModal,
  showNewCustomerModal,
  showNewTicketModal,
  showSentTextModal,
  showSnoozeModal,
  slaDelete,
  slaEdit,
  slaNew,
  slaToggle,
  sortTickets,
  ssoLogin,
  submitCreate,
  submitForgot,
  submitLogin,
  submitSupport,
  summarizeTicket,
  tagDelete,
  tagEdit,
  tagNew,
  tagSetQuery,
  tagSetType,
  testKbConnection,
  toggleAIMenu,
  toggleAllCustomers,
  toggleAllTags,
  toggleAllTickets,
  toggleAutoTranslateReplies,
  toggleCustSelected,
  toggleFAQ,
  toggleKBFeatured,
  toggleNotifPref,
  toggleNotifications,
  togglePassword,
  togglePermission,
  toggleProfileMenu,
  toggleQuickSwitcher,
  toggleSendMenu,
  toggleTagSelected,
  toggleThreadTranslate,
  toggleTicketSelected,
  toggleWatch,
  tplDelete,
  tplDuplicate,
  tplEdit,
  tplNew,
  tplSetQuery,
  translateMessage,
  ttDelete,
  ttDuplicate,
  ttEdit,
  ttNew,
  ttSetQuery,
  unlinkTicket,
  unmergeCustomer,
  unmergeTicket,
  unsnoozeTicket,
  updateCustomField,
  updateProfileInitials,
  updateProfileName,
  updatePwStrength,
  useFollowUp,
  voteKB,
  wfDelete,
  wfEdit,
  wfNew,
  wfRunNow,
  wfSetFilter,
  wfSetQuery,
  wfToggle,
  whApplyTemplate,
  whDelete,
  whEdit,
  whNew,
  whTestFire,
  whToggle,
  widgetDragDrop,
  widgetDragEnd,
  widgetDragLeave,
  widgetDragOver,
  widgetDragStart,
});
