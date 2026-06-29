// ─── Configuration hub ───────────────────────────────────────────────────────
// The landing page behind the top-bar settings cog. Replaces the old sidebar
// "Config" section: every config/admin area now lives here as a card with a
// one-line summary of what it does. Cards navigate via the existing
// `app.nav` action (data-page = the area's route key), so no new actions are
// registered here. renderConfigHub is the router entry (page key `config`),
// imported directly by core/router.js.
//
// Roles & Permissions is admin-gated to mirror the rest of the app (the roles
// page is read-only for non-admins, but we hide the card to keep the hub tidy);
// the platform/God view stays in the sidebar, not here, since it's a
// platform-admin tool rather than workspace config.

// Each group renders as a titled section of cards. `page` is the router key the
// card navigates to; `summary` is the ≤15-word blurb; `icon` reuses the
// matching sidebar glyph so the hub reads as the same surface, relocated.
const GROUPS = [
  {
    title: 'Ticketing & SLAs',
    items: [
      { page:'sla',              label:'SLA Policies',      summary:'Set response and resolution time targets per priority, with breach escalation.',
        icon:'<circle cx="6.5" cy="6.5" r="5" stroke="currentColor" stroke-width="1.2"/><path d="M6.5 3.5v3l2 1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>' },
      { page:'business-hours',   label:'Business Hours',    summary:'Define working hours and holidays that drive SLA timers and availability.',
        icon:'<rect x="1.5" y="2.5" width="10" height="9" rx="1" stroke="currentColor" stroke-width="1.1"/><path d="M1.5 5.5h10M4 1.5v2M9 1.5v2M3.5 8h2M7.5 8h2" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>' },
      { page:'assignment-rules', label:'Assignment Rules',  summary:'Auto-route incoming tickets to the right agents by round-robin or conditions.',
        icon:'<circle cx="3.5" cy="3.5" r="1.5" stroke="currentColor" stroke-width="1.1"/><circle cx="9.5" cy="3.5" r="1.5" stroke="currentColor" stroke-width="1.1"/><circle cx="6.5" cy="9.5" r="1.5" stroke="currentColor" stroke-width="1.1"/><path d="M3.5 5v1.5L6.5 8M9.5 5v1.5L6.5 8" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>' },
      { page:'csat',             label:'CSAT Surveys',      summary:'Send satisfaction surveys after resolution and collect customer ratings.',
        icon:'<path d="M6.5 1.8l1.45 2.94 3.25.47-2.35 2.29.55 3.23L6.5 9.2 3.6 10.73l.55-3.23-2.35-2.29 3.25-.47z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>' },
    ],
  },
  {
    title: 'Productivity & Content',
    items: [
      { page:'templates',        label:'Templates',         summary:'Reusable reply snippets agents can drop into customer responses.',
        icon:'<rect x="2" y="1.5" width="9" height="10" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M4 4.5h5M4 6.5h5M4 8.5h3" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>' },
      { page:'macros',           label:'Macros',            summary:'One-click actions that update, reply to, and resolve tickets together.',
        icon:'<path d="M6.5 1.5l-3 5h2.5l-1 4.5 4-5.5h-2.5l1-4z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>' },
      { page:'ticket-templates', label:'Ticket Templates',  summary:'Pre-filled new-ticket forms for common, repeatable request types.',
        icon:'<rect x="1.5" y="2.5" width="10" height="8" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M1.5 4.5h10M3.5 7h6M3.5 8.5h4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>' },
    ],
  },
  {
    title: 'Data Model',
    items: [
      { page:'custom-fields',    label:'Custom Fields',     summary:'Add extra fields to capture on tickets and customer records.',
        icon:'<rect x="1.5" y="3" width="10" height="3" rx=".7" stroke="currentColor" stroke-width="1.2"/><rect x="1.5" y="7.5" width="10" height="3" rx=".7" stroke="currentColor" stroke-width="1.2"/><circle cx="3.5" cy="4.5" r=".7" fill="currentColor"/><circle cx="3.5" cy="9" r=".7" fill="currentColor"/>' },
      { page:'layouts',          label:'Layouts',           summary:'Choose which fields show and are required on ticket and customer forms.',
        icon:'<rect x="1.5" y="1.5" width="4" height="4" rx=".7" stroke="currentColor" stroke-width="1.1"/><rect x="7.5" y="1.5" width="4" height="4" rx=".7" stroke="currentColor" stroke-width="1.1"/><rect x="1.5" y="7.5" width="10" height="4" rx=".7" stroke="currentColor" stroke-width="1.1"/>' },
      { page:'tags',             label:'Tags',              summary:'Manage the tag library used to label tickets and customers.',
        icon:'<path d="M1.5 6.5L6.5 1.5h4v4L5.5 11.5l-4-4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="9" cy="4" r="1" fill="currentColor"/>' },
    ],
  },
  {
    title: 'Channels & Integrations',
    items: [
      { page:'channels',         label:'Channels',          summary:'Connect email, chat, and other inbound message sources.',
        icon:'<path d="M1.5 4.5h10v6h-10z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M1.5 4.5l5 4 5-4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="11" cy="3" r="1.5" fill="currentColor"/>' },
      { page:'webhooks',         label:'Webhooks',          summary:'Push ticket events to external systems in real time.',
        icon:'<path d="M3 3.5l4 4 4-4M3 9.5h8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>' },
    ],
  },
  {
    title: 'Workspace',
    items: [
      { page:'roles',            label:'Roles & Permissions', summary:'Control what each agent role can see and do.', adminOnly:true,
        icon:'<rect x="1" y="1" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.2"/><path d="M4 4h5M4 6.5h3M4 9h2" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>' },
      { page:'settings',         label:'Preferences',         summary:'Your profile, appearance, notifications, AI, language, and integrations.',
        icon:'<circle cx="6.5" cy="6.5" r="1.8" stroke="currentColor" stroke-width="1.2"/><path d="M6.5 1.5v1.5M6.5 10v1.5M11.5 6.5h-1.5M3 6.5h-1.5M9.6 9.6l-1.1-1.1M4.5 4.5l-1.1-1.1M9.6 3.4l-1.1 1.1M4.5 8.5l-1.1 1.1" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>' },
      { page:'help',             label:'Help & Support',      summary:'Guides, keyboard shortcuts, FAQ, and ways to contact support.',
        icon:'<circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" stroke-width="1.2"/><path d="M5 5.2c0-1 .7-1.7 1.6-1.7s1.6.7 1.6 1.6c0 .9-1.6 1-1.6 2.1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="6.5" cy="9.5" r=".7" fill="currentColor"/>' },
    ],
  },
];

function card(item) {
  return `
    <div class="confighub-card" data-action="app.nav" data-page="${window.escAttr(item.page)}">
      <svg class="confighub-icon" viewBox="0 0 13 13" fill="none">${item.icon}</svg>
      <div class="confighub-body">
        <div class="confighub-label">${window.escHtml(item.label)}</div>
        <div class="confighub-summary">${window.escHtml(item.summary)}</div>
      </div>
      <svg class="confighub-chev" viewBox="0 0 13 13" fill="none"><path d="M5 3l3.5 3.5L5 10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>`;
}

export function renderConfigHub() {
  const admin = window.isAdmin();
  const groups = GROUPS.map(g => {
    const items = g.items.filter(i => !i.adminOnly || admin);
    if (!items.length) return '';
    return `
      <div class="confighub-group">
        <div class="confighub-group-title">${window.escHtml(g.title)}</div>
        <div class="confighub-grid">${items.map(card).join('')}</div>
      </div>`;
  }).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Configuration</div>
        <span class="confighub-subtitle">Everything that shapes how this workspace handles tickets, customers, and channels.</span>
      </div>
      <div class="page-scroll">${groups}</div>
    </div>`;
}
