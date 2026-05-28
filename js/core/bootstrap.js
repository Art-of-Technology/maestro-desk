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
  const [ticketsRes, customersRes, agentsRes, inboxRes, channelsRes] = await Promise.all([
    apiGet('/api/v1/tickets?limit=200'),
    apiGet('/api/v1/customers'),
    apiGet('/api/v1/agents'),
    apiGet('/api/v1/inbox'),
    apiGet('/api/v1/channels'),
  ]);

  const customersRaw = customersRes.customers || [];
  const agentsRaw    = agentsRes.agents       || [];
  const ticketsRaw   = ticketsRes.tickets     || [];
  const inboxRaw     = inboxRes.inbox         || [];
  const channelsRaw  = channelsRes.channels   || [];

  // Build UUID → display_id and UUID → user-name maps for the ticket join.
  const customerByUuid = Object.fromEntries(customersRaw.map((c) => [c.id, c]));
  const userByUuid     = Object.fromEntries(agentsRaw.map((a) => [a.user_id, a.users]));
  const channelByUuid  = Object.fromEntries(channelsRaw.map((c) => [c.id, c]));

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
    userId:   a.user_id,    // DB UUID — used by PATCH /tickets when assigning
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
    _uuid:           t.id,          // DB UUID — used by detail fetch
    _detailLoaded:   false,         // flips true after loadTicketDetail
    id:              t.display_id,
    subject:         t.subject,
    customerId:      customerByUuid[t.customer_id]?.display_id || null,
    status:          t.status_key,
    priority:        t.priority_key,
    category:        labelCase(t.category_key) || 'Other',
    agent:           userByUuid[t.assigned_user_id]?.name || '',
    created:         isoDate(t.created_at),
    updated:         fmtRelative(t.updated_at),
    sla:             t.sla_state || 'ok',
    snoozedUntil:    t.snoozed_until || null,
    snoozedAt:       t.snoozed_at    || null,
    snoozeReason:    t.snooze_reason || null,
    snoozeWokenAt:   t.snooze_woken_at || null,
    _mergedIntoUuid: t.merged_into_id || null,
    mergedInto:      null,            // back-filled below from ticketByUuid
    mergedAt:        t.merged_at || null,
    mergedFrom:      [],              // back-filled below
    _statusBeforeMerge: t.status_before_merge || null,
    tags:            [],   // populated by loadTicketDetail on open
    aiTags:          [],
    csat:            null,
    msgs:            [],
    timeEntries:     [],
  }));
  // Resolve merge pointers display_id ↔ display_id across the loaded set.
  // Children outside the current page won't appear in mergedFrom — paginate-
  // aware merge graphs are a future PR.
  const ticketByUuid = Object.fromEntries(mappedTickets.map((m) => [m._uuid, m]));
  for (const m of mappedTickets) {
    if (m._mergedIntoUuid) {
      const parent = ticketByUuid[m._mergedIntoUuid];
      if (parent) {
        m.mergedInto = parent.id;
        parent.mergedFrom.push(m.id);
      }
    }
  }
  replaceInPlace(TICKETS, mappedTickets);

  // ─── CHANNELS ───────────────────────────────────────────────────────────
  // Map UUIDs to display_ids so the rest of the UI (which expects "CH-001"
  // style ids) keeps matching. Stash the UUID in `_uuid` for future writes.
  const mappedChannels = channelsRaw.map((c) => ({
    _uuid:           c.id,
    id:              c.display_id,
    name:            c.name,
    type:            c.type,
    address:         c.address || '',
    status:          c.status,
    defaultCategory: c.default_category_key || 'all',
    defaultAgent:    c.default_agent_name || '',
    signature:       c.signature || '',
    volume30d:       c.volume_30d || 0,
  }));
  replaceInPlace(CHANNELS, mappedChannels);

  // ─── INBOX ──────────────────────────────────────────────────────────────
  // inbox_messages has no display_id column, so the id stays a UUID — fine,
  // the UI uses it only for row selection. channelId is mapped to the
  // channel's display_id so the existing `CHANNELS.find(c => c.id === e.channelId)`
  // pattern keeps working.
  const mappedInbox = inboxRaw.map((e) => ({
    _uuid:              e.id,
    id:                 e.id,
    channelId:          channelByUuid[e.channel_id]?.display_id || e.channel_id,
    from:               e.from_name || '',
    fromEmail:          e.from_email || '',
    subject:            e.subject || '',
    body:               e.body || '',
    receivedAt:         fmtInboxDate(e.received_at),
    status:             e.status,
    convertedTicketId:  e.converted_ticket_display_id || null,
  }));
  replaceInPlace(INBOX, mappedInbox);
}

// Fetches the full detail (messages, tags, ai_tags, time_entries) for a
// single ticket and merges into the existing TICKETS entry in place.
// Idempotent: second call is a cheap no-op via the _detailLoaded flag.
// Returns the ticket after merge (or null if not found / not loadable).
export async function loadTicketDetail(displayId) {
  const t = TICKETS.find((x) => x.id === displayId);
  if (!t) return null;
  if (!t._uuid) return t;          // demo persona ticket — nothing to load
  if (t._detailLoaded) return t;

  const res = await apiGet(`/api/v1/tickets/${t._uuid}`);
  const d = res.ticket;
  if (!d) return t;

  // Build a UUID → display_id lookup for messages that came from a
  // merged source ticket, so the per-message mergedFrom tag matches the
  // existing data.js shape (display_id string, not UUID).
  const ticketByUuid = Object.fromEntries(TICKETS.map((x) => [x._uuid, x.id]));

  // Map messages to data.js shape ({from, r, t, ts, mentions, mergedFrom?}).
  t.msgs = (d.messages || []).map((m) => ({
    from:       m.author_label,
    r:          m.role,
    t:          m.body,
    ts:         fmtTime(m.created_at),
    mentions:   m.mentions || [],
    mergedFrom: m.merged_from_id ? (ticketByUuid[m.merged_from_id] || null) : undefined,
  }));
  t.tags        = d.tags || [];
  t.aiTags      = (d.ai_tags || []).map((x) => ({ tag: x.tag, conf: x.confidence, accepted: x.accepted }));
  t.timeEntries = (d.time_entries || []).map((te) => ({
    id:       te.id,
    agent:    te.user_name || '',
    minutes:  te.minutes,
    note:     te.note || '',
    billable: te.billable,
    ts:       fmtTimestampLong(te.created_at),
  }));

  // Sidebar metadata
  t.csat            = d.csat_score ?? null;
  t.csatStars       = d.csat_stars ?? null;
  t.csatComment     = d.csat_comment || '';
  t.csatRequestedAt = d.csat_requested_at ? isoDate(d.csat_requested_at) : null;
  t.csatSubmittedAt = d.csat_submitted_at ? isoDate(d.csat_submitted_at) : null;
  t.snoozedUntil    = d.snoozed_until || null;
  t.snoozedAt       = d.snoozed_at || null;
  t.snoozeReason    = d.snooze_reason || '';
  t.resolvedAt      = d.resolved_at || null;

  // Merge state — the detail endpoint joins the primary's display_id and
  // the children's display_ids so the SPA's merge banner + merged-duplicates
  // sidebar block don't need cross-ticket lookups.
  t.mergedInto         = d.merged_into_display_id || null;
  t.mergedAt           = d.merged_at ? isoDate(d.merged_at) : null;
  t.mergedFrom         = d.merged_from_display_ids || [];
  t._statusBeforeMerge = d.status_before_merge || null;

  t._detailLoaded = true;
  return t;
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

// "HH:MM" — matches data.js's `ts: '09:12'` shape for messages.
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toTimeString().slice(0, 5);
}

// "YYYY-MM-DD HH:MM" — matches data.js's INBOX receivedAt shape.
function fmtInboxDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const date = d.toISOString().slice(0, 10);
  const time = d.toTimeString().slice(0, 5);
  return `${date} ${time}`;
}

// "YYYY-MM-DD HH:MM" — matches data.js's time-entry ts shape.
function fmtTimestampLong(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const date = d.toISOString().slice(0, 10);
  const time = d.toTimeString().slice(0, 5);
  return `${date} ${time}`;
}
