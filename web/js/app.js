// app.js is the bootstrap entry: it owns login/logout, the workspace-brand
// swap, layout hydration, the window bridge, the static-shell action wiring,
// and the auto-resume startup. Page routing (nav/renderPage/updateNavBadges)
// moved to core/router.js — imported below and re-exposed on the bridge.
import { DASH_LAYOUT, REPORT_LAYOUT, SESSION, setDashLayout, setReportLayout, setSession } from './core/state.js';
import { THEME, applyTheme } from './core/theme.js';
import { checkSnoozeWakeups } from './tickets/snooze.js';
import { refreshAllSLA } from './tickets/sla.js';
import { registerActions } from './core/event-delegation.js';
import './core/dismiss.js';
import { initGlobalSearchInput } from './global-search/index.js';
import './profile-menu/index.js';  // side-effect: registers profmenu.* actions for the static top-bar dropdown
import './auth/index.js';  // side-effect: registers auth.* actions for the static auth screen
import { beginSetPassword } from './auth/index.js';
import { refreshNotifBadge } from './notifications/index.js';
import { autoResumePlatformAdmin } from './auth/platform-admin.js';
import { autoResumeAgent } from './auth/agent-login.js';
import { signOut as authSignOut } from './core/auth-client.js';
import {
  // setSettingsTab stays window-reachable: notifications reaches it via
  // window.setSettingsTab to dodge the settings↔notifications import cycle.
  setSettingsTab,
} from './settings/index.js';
import { DASH_WIDGETS, DEFAULT_DASH_LAYOUT } from './dashboard/index.js';
import { loadLayout, reconcileLayout } from './core/widget-shell.js';
import { REPORT_WIDGETS, DEFAULT_REPORT_LAYOUT } from './reports/index.js';
import { nav, renderPage } from './core/router.js';

// keybindings.js registers the global `/` and Cmd-K shortcuts as a side effect
// of import. Callers import navTo/focusGlobalSearch from core/keybindings.js
// directly, so this is a pure side-effect import.
import './core/keybindings.js';
import { stopPresence } from './core/presence.js';
import { startListSync, stopListSync } from './tickets/list-sync.js';
import { startRealtime, stopRealtime } from './core/realtime.js';

function login(role, name, initials, userId = null) {
  setSession({ role, name, initials, userId });
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
  if (userId) { startListSync(); startRealtime(); }
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
  // Tear down the Pubby realtime socket (no-op if it never connected).
  stopRealtime();
  setSession(null);
  resetWorkspaceBrand();
  // Clears JWT + workspace_id + cached user from sessionStorage. Safe for
  // demo personas (which never stored anything) and load-bearing for real-
  // auth users (so the next page-load doesn't auto-resume).
  authSignOut();
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

// ─── Navigation ───────────────────────────────────────────────────────────────
// nav / renderPage / updateNavBadges now live in core/router.js (imported
// above). app.js calls renderPage from login() and re-exposes all three on the
// window bridge for the ~150 module call sites that reach them via window.

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
setDashLayout(loadLayout('dash_layout',   DEFAULT_DASH_LAYOUT));
setReportLayout(loadLayout('report_layout', DEFAULT_REPORT_LAYOUT));
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
// Re-exposes a handful of functions onto window. Every feature module has
// retired from the bridge — their exports reach callers via direct ES imports
// or each module's own data-action handlers, so there are no namespace spreads
// left here. Routing (nav/renderPage/updateNavBadges) also left the bridge —
// every former window.nav / window.renderPage / window.updateNavBadges call
// site now imports directly from core/router.js.
//
// What remains, and why it can't simply drop:
//   • login/logout — bootstrap, still in app.js; reached by window.logout from
//     several modules and by the static index.html shell.
//   • applyWorkspaceBrand/resetWorkspaceBrand — white-label hooks.
//   • fmtMinutes/escHtml/escAttr/isAdmin — app-wide utilities used from many
//     module-rendered HTML strings.
//   • setSettingsTab — notifications reaches it via window to dodge the
//     settings↔notifications import cycle.
Object.assign(
  window,
  { login, logout, applyWorkspaceBrand, resetWorkspaceBrand,
    fmtMinutes, escHtml, escAttr, isAdmin,
    // notifications reaches this via window to avoid a settings↔notifications cycle
    setSettingsTab },
);

// Static index.html shell handlers (sidebar nav items + the sign-out foot).
// nav is imported from core/router.js; logout is app-local. The shell reaches
// both only through these data-action handlers.
registerActions({
  'app.nav':    (ds, el) => nav(ds.page, el),
  'app.logout': () => logout(),
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
    // Landing from an emailed set-password / invite link? Show the
    // set-password panel and strip the token from the URL so a refresh
    // doesn't reuse or leak it. Skip auto-resume in that case.
    const resetToken = new URLSearchParams(location.search).get('reset_token');
    if (resetToken) {
      beginSetPassword(resetToken);
      const clean = new URL(location.href);
      clean.searchParams.delete('reset_token');
      history.replaceState({}, '', clean.toString());
      return;
    }
    if (await autoResumeAgent()) return;
    await autoResumePlatformAdmin();
  } catch (err) {
    console.warn('[startup] auto-resume failed:', err);
  }
})();

