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
  renderTickets, initTicketsPage,
  setStatusFilter, sortTickets,
  setAgentFilter, setTicketView, setTicketQuery, setTicketGroupBy,
  toggleTicketSelected, toggleAllTickets, clearTicketSelection,
  bulkAssignTickets, bulkSetStatus, bulkSetPriority,
  bulkAddTag, bulkExportTickets, bulkDeleteTickets,
  exportTicketList,
} from './tickets/list.js';
import {
  openTicket, setComposeTab,
  toggleWatch, insertMacro,
  changeTicketStatus, quickStatus,
  addTicketTag, removeTicketTag,
  changeTicketPriority, changeTicketAgent,
  acceptAITag, acceptAllAITags, prevNextTicket,
  onComposeInput, insertVar,
  toggleAIMenu, hideAIMenu, toggleSendMenu, hideSendMenu,
  sendComposeAnd, sendCompose, showSentTextModal,
  showNewTicketModal, ntApplyTemplate,
} from './tickets/detail.js';
import {
  loadLayout, reconcileLayout, renderWidgetGrid,
  widgetDragStart, widgetDragEnd, widgetDragOver, widgetDragLeave, widgetDragDrop,
  hideWidgetById, showWidgetById, setWidgetChart, resetWidgetLayout,
  showWidgetMenu, showManageWidgetsModal,
} from './core/widget-shell.js';
import {
  renderReports, computeReportStats,
  setReportTF, exportReport,
  REPORT_WIDGETS, DEFAULT_REPORT_LAYOUT,
} from './reports/index.js';
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
  if (page === 'tickets') initTicketsPage();
  applyCollapsibleHeaders();
  updateNavBadges();
}

// ─── Page-render hooks (updateNavBadges) ────────────────────────────────────
// initTicketsPage moved to tickets/list.js; renderPage above still calls it
// through the import so the table's "select all" indeterminate state lands
// after innerHTML.
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

// ─── Layout hydration (dashboard + reports) ───────────────────────────────
// DASH_LAYOUT and REPORT_LAYOUT are declared in core/state.js; the dashboard
// module owns DASH_WIDGETS / DEFAULT_DASH_LAYOUT and the reports module
// owns REPORT_WIDGETS / DEFAULT_REPORT_LAYOUT — both imported above.
// Hydrate each layout from localStorage at startup, then reconcile against
// its widget list so newly-added widgets land at the end of the order
// rather than disappearing.
DASH_LAYOUT   = loadLayout('dash_layout',   DEFAULT_DASH_LAYOUT);
REPORT_LAYOUT = loadLayout('report_layout', DEFAULT_REPORT_LAYOUT);
reconcileLayout(DASH_LAYOUT,   DASH_WIDGETS);
reconcileLayout(REPORT_LAYOUT, REPORT_WIDGETS);

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
  DASH_WIDGETS,
  DEFAULT_DASH_LAYOUT,
  DEFAULT_REPORT_LAYOUT,
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
  REPORT_WIDGETS,
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
