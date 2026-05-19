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
  runMacro, bulkRunMacro, showApplyMacroModal, showMacroPanel,
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
import { renderInbox } from './inbox/index.js';
import { renderChannels } from './channels/index.js';
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
import './core/dismiss.js';
import './core/event-delegation.js';
import { navTo, focusGlobalSearch } from './core/keybindings.js';
import { renderProfile } from './profile/index.js';
import { renderAgents } from './agents/index.js';
import { toggleProfileMenu, profileMenuGo } from './profile-menu/index.js';
import {
  SEARCH_PAGES, globalSearch, gsGo, gsKey, gsOpenAllResults,
  renderSearchResults, searchPageSetQuery,
} from './global-search/index.js';
import {
  showAuthPanel, togglePassword, ssoLogin,
  submitLogin, submitForgot, submitCreate, updatePwStrength,
} from './auth/index.js';
import {
  renderTicketTemplates, ttSetQuery,
  ttNew, ttEdit, ttDuplicate, ttDelete,
} from './ticket-templates/index.js';
import {
  refreshNotifBadge, renderNotificationsPage, toggleNotifications,
} from './notifications/index.js';
import {
  renderKB, voteKB, toggleKBFeatured,
  kbSetQuery, kbSetCat, openKBArticle, closeKBArticle,
  kbNewArticle, kbEditArticle, kbDeleteArticle,
} from './kb/index.js';
import { renderHelp } from './help/index.js';
import {
  renderSettings, setSettingsTab,
  updateProfileName, updateProfileInitials,
  toggleNotifPref, setKbCfg, testKbConnection,
} from './settings/index.js';
import {
  renderLayouts, isFieldVisible, isFieldRequired,
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
  showGDPRModal, openCustomerModal, showCSVModal, showNewCustomerModal,
} from './customers/modals.js';
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
  renderReports, REPORT_WIDGETS, DEFAULT_REPORT_LAYOUT,
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

// ─── Namespace imports (window-bridge use only) ────────────────────────────────
// Every module re-exposed on window for inline on*= handlers gets a namespace
// import here. The bridge below spreads each namespace, so the explicit
// per-function list (~318 entries) is gone — bun dedupes the duplicate
// imports at bundle time.
import * as Theme from './core/theme.js';
import * as AIClient from './ai/client.js';
import * as Summarize from './ai/summarize.js';
import * as Translate from './ai/translate.js';
import * as AIReply from './ai/reply.js';
import * as TimeTracking from './tickets/time-tracking.js';
import * as Snooze from './tickets/snooze.js';
import * as SLA from './tickets/sla.js';
import * as SLAPolicies from './tickets/sla-policies.js';
import * as Linked from './tickets/linked.js';
import * as Mentions from './tickets/mentions.js';
import * as Drafts from './tickets/drafts.js';
import * as ActivityLog from './core/activity-log.js';
import * as Macros from './tickets/macros.js';
import * as Attachments from './tickets/attachments.js';
import * as AIPage from './ai/page.js';
import * as Portal from './portal/preview.js';
import * as Webhooks from './webhooks/index.js';
import * as KBIntegration from './kb-integration/index.js';
import * as Modal from './core/modal.js';
import * as Collapsible from './core/collapsible.js';
import * as Keybindings from './core/keybindings.js';
import * as ProfileMenu from './profile-menu/index.js';
import * as GlobalSearch from './global-search/index.js';
import * as Auth from './auth/index.js';
import * as TicketTemplates from './ticket-templates/index.js';
import * as KB from './kb/index.js';
import * as Settings from './settings/index.js';
import * as CustomFields from './custom-fields/index.js';
import * as Roles from './roles/index.js';
import * as Workflows from './workflows/index.js';
import * as Tags from './tags/index.js';
import * as Customers from './customers/index.js';
import * as CustomerModals from './customers/modals.js';
import * as Dashboard from './dashboard/index.js';
import * as TicketsList from './tickets/list.js';
import * as TicketDetail from './tickets/detail.js';
import * as WidgetShell from './core/widget-shell.js';
import * as BusinessHours from './core/business-hours.js';
import * as AssignmentRules from './tickets/assignment-rules.js';
import * as Templates from './tickets/templates.js';
import * as CSAT from './tickets/csat.js';

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

// ─── Window bridge ─────────────────────────────────────────────────────────────
// Re-exposes module-scope functions onto window for inline on*= handlers
// (which resolve identifiers via the global scope and don't see ES-module
// bindings). Each feature module is spread in as a whole namespace below —
// any of its exports becomes available on window. The named imports above
// remain for app.js's own use; bun dedupes them at bundle time.
//
// App.js-local fns (login/logout/nav/renderPage/updateNavBadges and the
// app-wide utilities fmtMinutes/escHtml/escAttr/isAdmin) get explicit
// entries because they aren't owned by any feature module.
//
// To kill a bridge entry: stop calling it from inline on*= handlers. To
// retire a whole module from the bridge: confirm no on*= handlers reference
// any of its exports, then drop the namespace spread.
Object.assign(
  window,
  { login, logout, nav, renderPage, updateNavBadges,
    fmtMinutes, escHtml, escAttr, isAdmin,
    toggleNotifications },
  Theme, AIClient, Summarize, Translate, AIReply,
  TimeTracking, Snooze, SLA, SLAPolicies, Linked, Mentions, Drafts,
  ActivityLog, Macros, Attachments, AIPage, Portal,
  Webhooks, KBIntegration,
  Modal, Collapsible, Keybindings,
  ProfileMenu, GlobalSearch,
  Auth, TicketTemplates, KB,
  Settings, CustomFields, Roles, Workflows,
  Tags, Customers, CustomerModals, Dashboard,
  TicketsList, TicketDetail, WidgetShell,
  BusinessHours, AssignmentRules, Templates, CSAT,
);

