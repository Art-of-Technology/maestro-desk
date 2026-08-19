// ─── Router ──────────────────────────────────────────────────────────────────
// The app's single-page navigation core: nav() (sidebar click → render),
// renderPage() (the page registry + per-page state reset + post-render hooks),
// and updateNavBadges() (the open-ticket / notification badge refresh that every
// page render ends with).
//
// Extracted from app.js. Every caller (feature modules + app.js's own login /
// shell wiring) imports nav / renderPage / updateNavBadges directly from here —
// they are no longer on the window bridge. router.js statically imports the
// per-page render modules, and several of those import renderPage back from
// router.js; that import cycle is safe because nav/renderPage/updateNavBadges
// are hoisted function declarations and are only ever called from event
// handlers, never at module-evaluation time.
//
// State is read/written through core/state.js imports: renderPage's per-page
// resets call setKbSelected/setCurrentPage/… and read CURRENT_PAGE etc. as live
// bindings. TICKETS is imported from core/data.js for updateNavBadges.

import { TICKETS } from './data.js';
import { CUSTOMER_SELECTED_IDS, TAG_SELECTED_NAMES, TICKET_SELECTED_IDS, setAgentSelected, setCurrentPage, setCurrentTicket, setCustomerSelected, setKbSelected, setRolesViewAgents, setTagSelected } from './state.js';
import { renderDashboard } from '../dashboard/index.js';
import { renderTickets, initTicketsPage } from '../tickets/list.js';
import { renderCustomers } from '../customers/index.js';
import { resetPlayerLookup } from '../customers/player-lookup.js';
import { renderReports } from '../reports/index.js';
import { renderSLABreach } from '../reports/sla-breach.js';
import { renderAgents } from '../agents/index.js';
import { renderAI, initAI } from '../ai/page.js';
import { renderKB } from '../kb/index.js';
import { renderTags } from '../tags/index.js';
import { renderRoles } from '../roles/index.js';
import { renderSLA } from '../tickets/sla-policies.js';
import { renderBusinessHours } from './business-hours.js';
import { renderAssignmentRules } from '../tickets/assignment-rules.js';
import { renderCSAT } from '../tickets/csat.js';
import { renderTemplates } from '../tickets/templates.js';
import { renderMacros } from '../tickets/macros.js';
import { renderTicketTemplates } from '../ticket-templates/index.js';
import { renderCustomFields } from '../custom-fields/index.js';
import { renderLayouts } from '../layouts/index.js';
import { renderActivityLog } from './activity-log.js';
import { renderPortal } from '../portal/preview.js';
import { renderSearchResults } from '../global-search/index.js';
import { renderChannels } from '../channels/index.js';
import { renderWebhooks } from '../webhooks/index.js';
import { renderSettings } from '../settings/index.js';
import { renderConfigHub } from '../config-hub/index.js';
import { renderHelp } from '../help/index.js';
import { renderNotificationsPage, refreshNotifBadge } from '../notifications/index.js';
import { renderProfile } from '../profile/index.js';
import { renderGod } from '../god/index.js';
import { applyCollapsibleHeaders } from './collapsible.js';
import { stopPresence } from './presence.js';
import { taglineCheck } from '../tagline-sdk/index.js';

// Merged sidebar destinations own extra page keys through their header tabs
// (Insights = reports|activity). Map those tab
// keys to the sidebar item that represents them so programmatic navigation
// (global search, quick switcher, deep links) highlights the right row. Keys
// with their own sidebar item — or none at all, e.g. config-hub-only pages like
// portal — need no entry; the lookup falls through to data-page or no highlight.
const NAV_ITEM_FOR_PAGE = { activity: 'reports', 'sla-breach': 'reports' };

export function nav(page, el) {
  document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
  // The top-bar config cog manages its own active state (set in app.config);
  // any sidebar/card navigation clears it so it doesn't stay visually pressed.
  document.getElementById('cog-btn')?.classList.remove('active');
  // Highlight the clicked element when we have one (sidebar row or config-hub
  // card); otherwise resolve the owning sidebar item from the page key so
  // programmatic callers don't each re-implement the lookup. Pages with no
  // sidebar row simply get no highlight.
  const item = el || document.querySelector(`.sb-item[data-page="${NAV_ITEM_FOR_PAGE[page] || page}"]`);
  if (item) item.classList.add('active');
  renderPage(page);
}

export function renderPage(page) {
  if (page !== 'roles')     setRolesViewAgents(null);
  if (page !== 'kb')        setKbSelected(null);
  if (page !== 'agents')    setAgentSelected(null);
  if (page !== 'customers') { setCustomerSelected(null); CUSTOMER_SELECTED_IDS.clear(); resetPlayerLookup(); }
  if (page !== 'tickets')   TICKET_SELECTED_IDS.clear();
  if (page !== 'tags')      { setTagSelected(null); TAG_SELECTED_NAMES.clear(); }
  setCurrentPage(page);
  setCurrentTicket(null);
  // Release the presence row for any ticket we were viewing — openTicket
  // re-acquires immediately if the new page lands on a detail view.
  stopPresence();
  const main = document.getElementById('main-area');
  const pages = {
    dashboard: renderDashboard,
    tickets:   renderTickets,
    customers: renderCustomers,
    reports:   renderReports,
    agents:    renderAgents,
    ai:        renderAI,
    kb:        renderKB,
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
    'sla-breach':  renderSLABreach,
    portal:        renderPortal,
    search:        renderSearchResults,
    channels:      renderChannels,
    webhooks:      renderWebhooks,
    settings:      renderSettings,
    config:        renderConfigHub,
    help:          renderHelp,
    notifications: renderNotificationsPage,
    profile:       renderProfile,
    god:           renderGod,
  };
  document.body.dataset.currentPage = page;
  // An unrecognised key used to leave whatever was rendered before on screen,
  // so a retired page (this PR removed 'inbox') would silently show the last
  // page's content under the new page's name. Fall back to the dashboard and
  // say so, rather than lying about where the user is.
  //
  // hasOwn, not a truthiness check: `pages` is an object literal, so
  // 'constructor' / 'toString' / 'valueOf' would otherwise pass the guard and
  // then be CALLED, painting [object Object] into the page.
  //
  // The route smoke fails the build when a listed route lands here: it
  // compares the key it asked for against document.body.dataset.currentPage
  // (see scripts/bridge-smoke-shim-suffix.js). Without that, deleting a
  // renderer while leaving its sidebar row would keep CI green and only
  // surface as a console message in the user's browser.
  if (!Object.hasOwn(pages, page)) {
    console.warn(`[router] unknown page "${page}" — falling back to dashboard`);
    // Guard the recursion: if 'dashboard' itself ever goes missing, fail
    // loudly instead of overflowing the stack.
    if (page === 'dashboard') throw new Error('[router] dashboard renderer is missing');
    renderPage('dashboard');
    // nav() resolved the sidebar highlight against the unknown key, so no row
    // is active — point it at the dashboard row we actually rendered.
    document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
    document.querySelector('.sb-item[data-page="dashboard"]')?.classList.add('active');
    return;
  }
  main.innerHTML = pages[page]();
  if (page === 'ai') initAI();
  if (page === 'tickets') initTicketsPage();
  applyCollapsibleHeaders();
  updateNavBadges();
  taglineCheck(page);
}

// ─── Page-render hooks (updateNavBadges) ────────────────────────────────────
// initTicketsPage lives in tickets/list.js; renderPage above still calls it
// through the import so the table's "select all" indeterminate state lands
// after innerHTML.
export function updateNavBadges() {
  document.getElementById('nb-open').textContent = TICKETS.filter(t => t.status === 'open' || t.status === 'escalated').length;
  refreshNotifBadge();
}
