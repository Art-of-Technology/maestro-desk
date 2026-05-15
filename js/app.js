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
  fmtSLAMinutes,
} from './tickets/sla.js';
import {
  renderSLA, slaToggle, slaNew, slaEdit, slaDelete,
} from './tickets/sla-policies.js';
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
  KB_INTEGRATION, KB_TICKET_CACHE, saveKbIntegration,
  fetchKbArticles, buildKbQuery, refreshTicketKbSuggestions,
} from './kb-integration/index.js';
import { showModal, closeModal } from './core/modal.js';
import {
  COLLAPSED_SECTIONS,
  applyCollapsibleHeaders, resetAllCollapsedSections,
} from './core/collapsible.js';
import { renderProfile } from './profile/index.js';
import {
  renderAgents, renderAgentDetail,
  openAgentDetail, closeAgentDetail,
  agentSetRole, agentSetStatus, agentSetQuery, agentNew,
} from './agents/index.js';
import { toggleProfileMenu, profileMenuGo } from './profile-menu/index.js';
import {
  SEARCH_PAGES, globalSearch, gsGo, gsKey, gsOpenAllResults,
  renderSearchResults, searchPageSetQuery,
} from './global-search/index.js';
import {
  toggleQuickSwitcher, qsSetActive,
  quickSwitcherInput, quickSwitcherKey, quickSwitcherPick,
} from './quick-switcher/index.js';
import {
  showAuthPanel, togglePassword, ssoLogin,
  submitLogin, submitForgot, submitCreate, updatePwStrength,
} from './auth/index.js';
import {
  renderTicketTemplates, ttSetQuery,
  ttNew, ttEdit, ttDuplicate, ttDelete,
} from './ticket-templates/index.js';
import {
  refreshNotifBadge, renderNotificationsPage,
  toggleNotifications, openNotification, closeNotifAndGo,
  markAllNotifRead, markAllNotifReadAndRender,
  notifPageSetType, notifPageSetRead,
  markNotifRead, dismissNotif, clearAllNotifications,
  openNotificationFromPage,
} from './notifications/index.js';
import {
  renderKB, voteKB, toggleKBFeatured,
  kbSetQuery, kbSetCat, openKBArticle, closeKBArticle,
  kbNewArticle, kbEditArticle, kbDeleteArticle,
} from './kb/index.js';
import { renderHelp, toggleFAQ, submitSupport } from './help/index.js';
import {
  renderSettings, setSettingsTab,
  updateProfileName, updateProfileInitials,
  toggleNotifPref, setKbCfg, testKbConnection,
} from './settings/index.js';
import {
  renderLayouts, setLayoutFieldFlag,
  isFieldVisible, isFieldRequired,
} from './layouts/index.js';
import {
  renderCustomFields,
  cfNew, cfEdit, cfDelete, cfFormToggleOptions,
  showManageFieldsModal,
} from './custom-fields/index.js';
import {
  renderRoles, openRoleAgents, closeRoleAgents,
  togglePermission, renameRolePrompt, deleteRolePrompt,
  addRolePrompt, addPermissionPrompt, addAgentToRolePrompt,
  reassignAgent, setAgentActive, deleteAgentPrompt,
} from './roles/index.js';
import {
  renderWorkflows,
  openWfDetail, closeWfDetail, duplicateWf,
  wfSetFilter, wfSetQuery, wfToggle, wfRunNow,
  wfNew, wfEdit, wfDelete,
} from './workflows/index.js';
import {
  renderTags, setTagSort,
  openTagDetail, closeTagDetail,
  toggleTagSelected, toggleAllTags, clearTagSelection,
  bulkSetTagType, bulkDeleteTags,
  convertTagType, mergeTagPrompt, mergeTags,
  tagSetType, tagSetQuery,
  tagNew, tagEdit, tagDelete,
} from './tags/index.js';
import {
  renderCustomers,
  showColumnPanel, dropCustCol, refreshCustTable,
  setCustView, setCustGroupBy,
  toggleCustSelected, toggleAllCustomers, clearCustSelection,
  bulkSetCustVIP, bulkSetCustConsent, bulkDeleteCustomers,
  exportCustomerList, filterCustomers, custSetVIP, custSetBrand,
  openCustomerProfile, closeCustomerProfile,
  addCustomerNote, deleteCustomerNote,
  showMergeCustomerModal, mergeCustomers, unmergeCustomer,
  updateCustomField, showCustomerGDPR,
} from './customers/index.js';
import {
  renderDashboard,
  openAgentFromDash, openKBFromDash,
  DASH_WIDGETS, DEFAULT_DASH_LAYOUT,
} from './dashboard/index.js';
import {
  bhSetEnabled, bhSetDayEnabled, bhSetDayTime,
  bhAddHoliday, bhRemoveHoliday, renderBusinessHours,
} from './core/business-hours.js';
import {
  isAgentOOO, showAgentOOOModal, clearAgentOOO,
  applyAssignmentRules, runAssignmentRulesOnTicket, bulkApplyAssignmentRules,
  arToggle, arModeChanged, arNew, arEdit, arDelete, renderAssignmentRules,
} from './tickets/assignment-rules.js';
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

// ─── Page-render hooks (initTicketsPage, updateNavBadges) ───────────────────
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

// ─── App-wide navigation helpers ─────────────────────────────────────────────
// navTo + focusGlobalSearch + the / and ⌘K keydown listeners live here.
// Not Help-page code — they sit next to it for historical reasons.
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

// ─── Customisable widget shell (dashboard + reports) ───────────────────────
// Each widget on the dashboard or reports page is wrapped with a chrome that
// provides a drag handle, a "..." menu (hide + chart-type switcher where
// available), and an aria-friendly hide button. Layouts (order, hidden set,
// per-widget chart choice) persist in localStorage so each agent's
// customisations stick across reloads.
const REPORT_WIDGETS = [
  { id:'r-status',    title:'Status breakdown', render:s => reportStatus(s),   charts:['bar','donut'] },
  { id:'r-sla',       title:'SLA',              render:s => reportSLA(s),      charts:['tiles','bar'] },
  { id:'r-priority',  title:'Priority',         render:s => reportPriority(s), charts:['bar','donut'] },
  { id:'r-category',  title:'Category',         render:s => reportCategory(s), charts:['bar','donut'] },
  { id:'r-agents',    title:'Tickets per agent',render:s => reportAgents(s) },
  { id:'r-csat',      title:'CSAT',             render:s => reportCSAT(s) },
  { id:'r-time',      title:'Time logged',      render:s => reportTime(s) },
];

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

// DASH_LAYOUT is declared in core/state.js (so the dashboard module and the
// widget-shell handlers here share one binding). Hydrate it once at startup,
// mirroring REPORT_LAYOUT below.
DASH_LAYOUT = loadLayout('dash_layout', DEFAULT_DASH_LAYOUT);
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

// ─── App-wide utilities (fmtMinutes, escHtml) ───────────────────────────────
// fmtMinutes was originally placed in the Agents section but is used widely
// (Reports, Tickets, Time tracking module). escHtml is one of the global
// string-escape utilities. Both stay in app.js — modules access via window.
function fmtMinutes(m) {
  if (!m) return '—';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${h}h${min ? ' ' + min + 'm' : ''}`;
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── CSAT surveys ────────────────────────────────────────────────────────────

// ─── App-wide utilities (isAdmin, escAttr) ─────────────────────────────────
// Physically lodged inside the Roles section originally; lifted out when
// Roles was extracted so they stay reachable across feature modules.
function isAdmin() { return SESSION?.role === 'Admin'; }
function escAttr(s) { return String(s).replace(/'/g, "\\'"); }

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
  COLLAPSED_SECTIONS,
  deleteAIConv,
  escAttr,
  escHtml,
  fetchKbArticles,
  fireWebhook,
  fmtMinutes,
  hideMentionDropdown,
  hideWidgetById,
  isAdmin,
  isAgentOOO,
  KB_INTEGRATION,
  KB_TICKET_CACHE,
  linkTickets,
  loadLayout,
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
  saveKbIntegration,
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
  computeReportStats,
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
  renderCategoricalChart,
  renderPage,
  renderWidgetGrid,
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
