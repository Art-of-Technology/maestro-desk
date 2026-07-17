// ─── Page tabs ───────────────────────────────────────────────────────────────
// A small header-level tab switcher for the merged nav destinations:
//   Conversations = Tickets | Inbox     Insights = Reports | Activity
// It renders inside a page's .topbar in place of the .tb-title. Each tab carries
// data-action="pagetab.go" data-page="<router key>"; the handler (registered in
// app.js) calls renderPage(key) directly — NOT nav() — so the sidebar's active
// item (the merged destination) stays highlighted while the tab flips the body.
//
// Tabs are label-only by design: the per-view counts already live in each page's
// KPI bar, and keeping them out avoids cross-importing TICKETS/INBOX here.
// The Insights tab set, shared by all three renderers (reports/index.js,
// core/activity-log.js, reports/sla-breach.js) so adding or renaming a tab
// is a one-place change. Lives here — the one leaf module all three already
// import — to avoid an import cycle through router.js.
export const INSIGHT_TABS = [
  { key: 'reports',    label: 'Reports' },
  { key: 'activity',   label: 'Activity' },
  { key: 'sla-breach', label: 'SLA Breaches' },
];

export function pageTabs(tabs, active) {
  return `<div class="hdr-tabs">${tabs.map(t =>
    `<span class="hdr-tab ${t.key === active ? 'active' : ''}" data-action="pagetab.go" data-page="${window.escAttr(t.key)}">${window.escHtml(t.label)}</span>`
  ).join('')}</div>`;
}
