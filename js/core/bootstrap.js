// Workspace data bootstrap.
//
// Called after a real-auth sign-in (or auto-resume) succeeds. Parallel-
// fetches tickets, customers, agents from the API and mutates the existing
// data.js global arrays in place to match the data.js view-model shape.
//
// Why mutate in place: ~60 modules read TICKETS / CUSTOMERS / AGENTS via
// the global lexical env. Replacing the binding would mean every module
// would have to be refactored to call a getter. Mutating preserves the
// array identity so callers see the new contents on their next render.
//
// Demo persona flow doesn't call this — it relies on data.js's seed data.
//
// Future PRs: WORKFLOWS, SLA_POLICIES, TAG_LIBRARY, KB_ARTICLES, INBOX,
// CHANNELS, ROLES_MATRIX, CANNED_RESPONSES, TICKET_TEMPLATES, CUSTOM_FIELDS,
// ASSIGN_RULES are still seeded from data.js. Each migrates per-feature.

import { apiGet } from './api-client.js';

export async function loadWorkspaceData() {
  const [ticketsRes, customersRes, agentsRes] = await Promise.all([
    apiGet('/api/v1/tickets?limit=200'),
    apiGet('/api/v1/customers'),
    apiGet('/api/v1/agents'),
  ]);

  const customersRaw = customersRes.customers || [];
  const agentsRaw    = agentsRes.agents       || [];
  const ticketsRaw   = ticketsRes.tickets     || [];

  // Build UUID → display_id and UUID → user-name maps for the ticket join.
  const customerByUuid = Object.fromEntries(customersRaw.map((c) => [c.id, c]));
  const userByUuid     = Object.fromEntries(agentsRaw.map((a) => [a.user_id, a.users]));

  // ─── CUSTOMERS ──────────────────────────────────────────────────────────
  const mappedCustomers = customersRaw.map((c) => ({
    id:           c.display_id,
    first:        c.first_name || '',
    last:         c.last_name || '',
    username:     c.username || '',
    email:        c.email || '',
    mobile:       c.mobile || '',
    brand:        c.brand || '',
    vip:          c.vip_tier || '',
    jurisdiction: c.jurisdiction || '',
    consent:      Boolean(c.consent),
    kyc:          c.kyc_status || '',
    since:        c.since || '',
    bo:           c.backoffice_url || '',
    custom:       {},
  }));
  replaceInPlace(CUSTOMERS, mappedCustomers);

  // ─── AGENTS ─────────────────────────────────────────────────────────────
  const mappedAgents = agentsRaw.map((a) => ({
    name:     a.users?.name || a.users?.email || 'Unknown',
    initials: a.users?.initials || initialsFromName(a.users?.name || a.users?.email || ''),
    role:     a.roles?.name || 'Member',
    active:   Boolean(a.active),
    oooFrom:  a.ooo_from || undefined,
    oooTo:    a.ooo_to   || undefined,
    oooNote:  a.ooo_note || undefined,
  }));
  replaceInPlace(AGENTS, mappedAgents);

  // ─── TICKETS ────────────────────────────────────────────────────────────
  const mappedTickets = ticketsRaw.map((t) => ({
    id:         t.display_id,
    subject:    t.subject,
    customerId: customerByUuid[t.customer_id]?.display_id || null,
    status:     t.status_key,
    priority:   t.priority_key,
    category:   labelCase(t.category_key) || 'Other',
    agent:      userByUuid[t.assigned_user_id]?.name || '',
    created:    isoDate(t.created_at),
    updated:    fmtRelative(t.updated_at),
    sla:        t.sla_state || 'ok',
    tags:       [],   // PR follow-up: GET /api/v1/tickets/:id/tags
    aiTags:     [],   // PR follow-up
    csat:       null, // PR follow-up
    msgs:       [],   // PR follow-up: GET /api/v1/tickets/:id/messages on detail open
  }));
  replaceInPlace(TICKETS, mappedTickets);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function replaceInPlace(target, source) {
  target.length = 0;
  for (const item of source) target.push(item);
}

function initialsFromName(s) {
  if (!s) return '??';
  const parts = s.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || s.slice(0, 2).toUpperCase();
}

function isoDate(iso) {
  return iso ? String(iso).slice(0, 10) : '';
}

// Crude relative formatter for the tickets-list "updated" column. Matches
// data.js's shape ("2 min ago" / "1h ago" / "2d ago"). Not localised — fix
// when the UI gets a real i18n layer.
function fmtRelative(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!then) return '';
  const diffSec = Math.max(0, (Date.now() - then) / 1000);
  if (diffSec < 60)         return Math.floor(diffSec) + 's ago';
  if (diffSec < 3600)       return Math.floor(diffSec / 60) + ' min ago';
  if (diffSec < 86400)      return Math.floor(diffSec / 3600) + 'h ago';
  if (diffSec < 86400 * 30) return Math.floor(diffSec / 86400) + 'd ago';
  return isoDate(iso);
}

// Capitalise the first letter of a lookup key ('billing' → 'Billing') so
// the UI's case-sensitive comparisons (filter chips, etc.) keep matching
// the data.js conventions. A category-labels lookup table is the cleaner
// long-term fix.
function labelCase(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
