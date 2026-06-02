import { THEME, applyTheme } from './core/theme.js';
import { checkSnoozeWakeups } from './tickets/snooze.js';
import {
  SLA_WARN_FRACTION, BUSINESS_HOURS,
  slaNowForDemo, invalidateSLAClock,
  findMatchingSLAPolicy, ticketFirstResponseMinutes, ticketElapsedMinutes,
  bhParseHM, isWithinBusinessHours, bhInvalidateCache, businessMinutesBetween,
  computeTicketSLA, refreshTicketSLA, refreshAllSLA,
  fmtSLAMinutes,
} from './tickets/sla.js';
import { renderSLA } from './tickets/sla-policies.js';
import { loadDraft, saveDraft, clearDraft } from './tickets/drafts.js';
import {
  logTicketEvent, getTicketEvents, renderActivityLog,
} from './core/activity-log.js';
import { renderMacros } from './tickets/macros.js';
import { showAttachPanel } from './tickets/attachments.js';
import { renderAI, initAI } from './ai/page.js';
import { renderPortal } from './portal/preview.js';
import { renderInbox } from './inbox/index.js';
import { renderChannels } from './channels/index.js';
import { fireWebhook, ticketPayload, renderWebhooks } from './webhooks/index.js';
import {
  KB_INTEGRATION, KB_TICKET_CACHE, saveKbIntegration,
  fetchKbArticles, buildKbQuery, refreshTicketKbSuggestions,
} from './kb-integration/index.js';
import { showModal, closeModal } from './core/modal.js';
import { applyCollapsibleHeaders } from './core/collapsible.js';
import './core/dismiss.js';
import { registerActions } from './core/event-delegation.js';
import { navTo, focusGlobalSearch } from './core/keybindings.js';
import { renderProfile } from './profile/index.js';
import { renderAgents } from './agents/index.js';
import './profile-menu/index.js';  // side-effect: registers profmenu.* actions for the static top-bar dropdown
import { renderSearchResults, initGlobalSearchInput } from './global-search/index.js';
import './auth/index.js';  // side-effect: registers auth.* actions for the static auth screen
import { renderTicketTemplates } from './ticket-templates/index.js';
import { refreshNotifBadge, renderNotificationsPage } from './notifications/index.js';
import { renderKB } from './kb/index.js';
import { renderHelp } from './help/index.js';
import { renderGod } from './god/index.js';
import { autoResumePlatformAdmin } from './auth/platform-admin.js';
import { autoResumeAgent } from './auth/agent-login.js';
import { signOut as authSignOut } from './core/auth-client.js';
import {
  renderSettings,
  // setSettingsTab stays window-reachable: notifications reaches it via
  // window.setSettingsTab to dodge the settings↔notifications import cycle.
  setSettingsTab,
} from './settings/index.js';
import {
  renderLayouts, isFieldVisible, isFieldRequired,
} from './layouts/index.js';
import { renderCustomFields } from './custom-fields/index.js';
import { renderRoles } from './roles/index.js';
import { renderWorkflows } from './workflows/index.js';
import { renderTags } from './tags/index.js';
import { renderCustomers } from './customers/index.js';
import {
  showGDPRModal, openCustomerModal, showCSVModal, showNewCustomerModal,
} from './customers/modals.js';
import {
  renderDashboard,
  DASH_WIDGETS, DEFAULT_DASH_LAYOUT,
} from './dashboard/index.js';
import { renderTickets, initTicketsPage } from './tickets/list.js';
import { loadLayout, reconcileLayout } from './core/widget-shell.js';
import {
  renderReports, REPORT_WIDGETS, DEFAULT_REPORT_LAYOUT,
} from './reports/index.js';
import { renderBusinessHours } from './core/business-hours.js';
import { renderAssignmentRules } from './tickets/assignment-rules.js';
import { renderTemplates } from './tickets/templates.js';
import { renderCSAT } from './tickets/csat.js';

// ─── Namespace imports (window-bridge use only) ────────────────────────────────
// Every module re-exposed on window for inline on*= handlers gets a namespace
// import here. The bridge below spreads each namespace, so the explicit
// per-function list (~318 entries) is gone — bun dedupes the duplicate
// imports at bundle time.
import * as KBIntegration from './kb-integration/index.js';
import * as Keybindings from './core/keybindings.js';
import * as CustomerModals from './customers/modals.js';
import { stopPresence } from './core/presence.js';
import { startListSync, stopListSync } from './tickets/list-sync.js';

function login(role, name, initials, userId = null) {
  SESSION = { role, name, initials, userId };
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
  // Real-auth users (userId != null) get the always-on list-sync poll so
  // TICKETS / nav badges / inbox stay live. Demo personas skip — they
  // have no API to talk to and TICKETS comes from data.js seeds.
  if (userId) startListSync();
  renderPage('dashboard');
}
// Swap the sidebar brand block (and the browser tab title) to the
// signed-in workspace's identity. Called from the agent-login boot
// flow after window.login; demo personas keep the platform-default
// copy because they never carry workspace metadata.
function applyWorkspaceBrand(brand) {
  if (!brand) return;
  const wordEl = document.querySelector('.sb-logo .sb-word');
  const subEl  = document.querySelector('.sb-logo .sb-sub');
  const logoEl = document.querySelector('.sb-logo');
  if (logoEl && brand.logoUrl) {
    // Render logo image alongside (in place of, visually) the word
    // mark. Use background-image so we don't have to restructure the
    // HTML — keeps the sub-text in flow.
    if (wordEl) {
      wordEl.style.backgroundImage    = `url("${brand.logoUrl}")`;
      wordEl.style.backgroundRepeat   = 'no-repeat';
      wordEl.style.backgroundPosition = 'left center';
      wordEl.style.backgroundSize     = 'auto 70%';
      wordEl.style.paddingLeft        = '34px';
      wordEl.style.minHeight          = '28px';
    }
  }
  if (wordEl && brand.name) wordEl.textContent = brand.name;
  if (subEl)                subEl.textContent  = brand.slug ? brand.slug : 'AI Helpdesk';
  if (brand.name) document.title = `${brand.name} — Helpdesk`;
  if (brand.primaryColor) {
    document.documentElement.style.setProperty('--purple', brand.primaryColor);
    document.documentElement.style.setProperty('--accent', brand.primaryColor);
  }
}

// Inverse of applyWorkspaceBrand — restores the platform-default
// copy so a subsequent demo-persona sign-in doesn't show stale
// branding from a previous workspace session.
function resetWorkspaceBrand() {
  const wordEl = document.querySelector('.sb-logo .sb-word');
  const subEl  = document.querySelector('.sb-logo .sb-sub');
  if (wordEl) {
    wordEl.textContent = 'Maestro Desk';
    wordEl.style.backgroundImage = '';
    wordEl.style.paddingLeft     = '';
    wordEl.style.minHeight       = '';
  }
  if (subEl) subEl.textContent = 'iGaming · AI Assisted';
  document.title = 'Maestro Desk — AI Support';
  document.documentElement.style.removeProperty('--purple');
  document.documentElement.style.removeProperty('--accent');
}

function logout() {
  // Release any presence row before we wipe the JWT — sendLeaveBeacon
  // needs the token to authorise the DELETE.
  stopPresence();
  // Stop the background list-sync poll. Always safe to call even when
  // never started (demo persona path).
  stopListSync();
  SESSION = null;
  resetWorkspaceBrand();
  // Clears JWT + workspace_id + cached user from sessionStorage. Safe for
  // demo personas (which never stored anything) and load-bearing for real-
  // auth users (so the next page-load doesn't auto-resume).
  authSignOut();
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
  // Release the presence row for any ticket we were viewing — openTicket
  // re-acquires immediately if the new page lands on a detail view.
  stopPresence();
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
    god:           renderGod,
  };
  document.body.dataset.currentPage = page;
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
//
// Some functions are kept as explicit single-fn entries (alongside the
// app-local fns above) because their only inline-handler callers are
// static markup in index.html — the namespace spread retires, but the
// specific functions stay window-reachable until index.html migrates.
Object.assign(
  window,
  { login, logout, nav, renderPage, updateNavBadges, applyWorkspaceBrand, resetWorkspaceBrand,
    fmtMinutes, escHtml, escAttr, isAdmin,
    // notifications reaches this via window to avoid a settings↔notifications cycle
    setSettingsTab },
  KBIntegration,
  Keybindings,
  CustomerModals,
);

// Static index.html shell handlers (sidebar nav items + the sign-out foot).
// nav/logout stay on the bridge above too — they're app-local bootstrap that
// other modules still reach via window.nav / window.logout.
registerActions({
  'app.nav':    (ds, el) => nav(ds.page, el),
  'app.logout': () => logout(),
  // demo-persona quick-login buttons on the static auth screen
  'app.login':  (ds) => login(ds.role, ds.name, ds.initials),
});

// Wire the static top-bar search input (#gs-input) — its input/focus/keydown
// handlers are attached programmatically (sparse events, single static element).
initGlobalSearchInput();

// ─── Startup: resume a real-auth session if one is in sessionStorage ───
// Agent resume wins if a workspace_id is stored — that's the user's
// explicit "I'm here as an agent" signal. Platform-admin resume is the
// fallback. Demo persona flow stays on the auth screen until the user
// clicks one.
(async () => {
  try {
    if (await autoResumeAgent()) return;
    await autoResumePlatformAdmin();
  } catch (err) {
    console.warn('[startup] auto-resume failed:', err);
  }
})();

