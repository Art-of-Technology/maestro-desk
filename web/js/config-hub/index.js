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
      { page:'portal',           label:'Customer Portal',   summary:'Preview the self-service portal your customers see, using real ticket data.',
        icon:'<circle cx="6.5" cy="6.5" r="5" stroke="currentColor" stroke-width="1.1"/><path d="M1.5 6.5h10M6.5 1.5c1.5 1.5 2.3 3.3 2.3 5s-.8 3.5-2.3 5M6.5 1.5c-1.5 1.5-2.3 3.3-2.3 5s.8 3.5 2.3 5" stroke="currentColor" stroke-width="1.1" fill="none"/>' },
    ],
  },
  {
    title: 'Workspace',
    items: [
      { page:'roles',            label:'Roles & Permissions', summary:'Control what each agent role can see and do.', adminOnly:true,
        icon:'<rect x="1" y="1" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.2"/><path d="M4 4h5M4 6.5h3M4 9h2" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>' },
      { page:'settings',         label:'Preferences',         summary:'Your profile, appearance, notifications, AI, language, and integrations.',
        icon:'<path d="M6.12483 0.563539C5.78072 0.563539 5.48246 0.801749 5.40638 1.13732L5.19972 2.04747C4.87124 2.14300 4.55790 2.27381 4.26411 2.43544L3.47424 1.93773C3.18315 1.75424 2.80381 1.79670 2.56050 2.04001L2.03518 2.56530C1.79188 2.80862 1.74941 3.18795 1.93290 3.47903L2.43061 4.26887C2.28908 4.56255 2.15841 4.87582 2.06299 5.20418L1.15268 5.41049C0.817124 5.48657 0.578979 5.78483 0.578979 6.12894V6.87213C0.578979 7.21622 0.817124 7.51451 1.15268 7.59059L2.06273 7.79701C2.15821 8.12547 2.28899 8.43884 2.43058 8.73262L1.93276 9.52293C1.74927 9.81401 1.79173 10.1933 2.03504 10.4367L2.56035 10.9620C2.80366 11.2053 3.18300 11.2477 3.47409 11.0642L4.26418 10.5663C4.55786 10.7278 4.87110 10.8586 5.19943 10.9541L5.40638 11.8646C5.48246 12.2001 5.78072 12.4382 6.12483 12.4382H6.86798C7.21208 12.4382 7.51036 12.2001 7.58644 11.8646L7.79281 10.9548C8.12143 10.8593 8.43483 10.7285 8.72870 10.5669L9.51879 11.0648C9.80988 11.2483 10.1892 11.2059 10.4325 10.9625L10.9578 10.4372C11.2011 10.1939 11.2436 9.81460 11.0601 9.52351L10.5622 8.73330C10.7038 8.43955 10.8347 8.12621 10.9302 7.79766L11.8404 7.59059C12.1759 7.51451 12.4141 7.21622 12.4141 6.87213V6.12894C12.4141 5.78483 12.1759 5.48657 11.8404 5.41049L10.9303 5.20416C10.8348 4.87584 10.7040 4.56258 10.5625 4.26890L11.0603 3.47872C11.2438 3.18764 11.2014 2.80829 10.9581 2.56498L10.4327 2.03967C10.1894 1.79636 9.81011 1.75390 9.51902 1.93739L8.72884 2.43506C8.43502 2.27346 8.12173 2.14267 7.79320 2.04717L7.58644 1.13732C7.51036 0.801749 7.21208 0.563539 6.86798 0.563539H6.12483ZM4.26055 6.50002C4.26055 5.26289 5.26340 4.26003 6.50053 4.26003C7.73766 4.26003 8.74051 5.26289 8.74051 6.50002C8.74051 7.73715 7.73766 8.74000 6.50053 8.74000C5.26340 8.74000 4.26055 7.73715 4.26055 6.50002Z" fill="none" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>' },
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
