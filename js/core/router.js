// ─── Router ──────────────────────────────────────────────────────────────────
// The app's single-page navigation core: nav() (sidebar click → render),
// renderPage() (the page registry + per-page state reset + post-render hooks),
// and updateNavBadges() (the open/inbox/notification badge refresh that every
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
// bindings. TICKETS and INBOX are imported from core/data.js for updateNavBadges.

import { INBOX, TICKETS } from './data.js';
import { CUSTOMER_SELECTED_IDS, TAG_SELECTED_NAMES, TICKET_SELECTED_IDS, setAgentSelected, setCurrentPage, setCurrentTicket, setCustomerSelected, setInboxSelectedId, setKbSelected, setRolesViewAgents, setTagSelected, setWfSelected } from './state.js';
import { renderDashboard } from '../dashboard/index.js';
import { renderTickets, initTicketsPage } from '../tickets/list.js';
import { renderInbox } from '../inbox/index.js';
import { renderCustomers } from '../customers/index.js';
import { renderReports } from '../reports/index.js';
import { renderAgents } from '../agents/index.js';
import { renderAI, initAI } from '../ai/page.js';
import { renderKB } from '../kb/index.js';
import { renderWorkflows } from '../workflows/index.js';
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
import { renderHelp } from '../help/index.js';
import { renderNotificationsPage, refreshNotifBadge } from '../notifications/index.js';
import { renderProfile } from '../profile/index.js';
import { renderGod } from '../god/index.js';
import { applyCollapsibleHeaders } from './collapsible.js';
import { stopPresence } from './presence.js';

export function nav(page, el) {
  document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');
  renderPage(page);
}

export function renderPage(page) {
  if (page !== 'roles')     setRolesViewAgents(null);
  if (page !== 'kb')        setKbSelected(null);
  if (page !== 'agents')    setAgentSelected(null);
  if (page !== 'customers') { setCustomerSelected(null); CUSTOMER_SELECTED_IDS.clear(); }
  if (page !== 'tickets')   TICKET_SELECTED_IDS.clear();
  if (page !== 'inbox')     setInboxSelectedId(null);
  if (page !== 'workflows') setWfSelected(null);
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
// initTicketsPage lives in tickets/list.js; renderPage above still calls it
// through the import so the table's "select all" indeterminate state lands
// after innerHTML.
export function updateNavBadges() {
  document.getElementById('nb-open').textContent = TICKETS.filter(t => t.status === 'open' || t.status === 'escalated').length;
  const inboxBadge = document.getElementById('nb-inbox');
  if (inboxBadge) {
    const newCount = INBOX.filter(e => e.status === 'new').length;
    inboxBadge.textContent = newCount;
    inboxBadge.style.display = newCount > 0 ? '' : 'none';
  }
  refreshNotifBadge();
}
