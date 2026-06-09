import { getDb } from './db.ts';

// Migration to Neon — Step 3 (tickets megabatch). DB via getDb().
//
// Server-side assignment-rules engine. Evaluates active rules against
// a ticket + its customer's VIP tier, picks an eligible agent based on
// the rule's mode (specific-agent / round-robin / least-busy), skips
// agents currently OOO, persists the assignment + rule bookkeeping
// (match_count, last_match_at, rr_index).
//
// Mirrors the client-side engine in js/tickets/assignment-rules.js so
// the new POST /tickets and POST /tickets/:id/apply-rules paths produce
// the same results the SPA used to compute locally.

interface Rule {
  id:            string;
  display_id:    string;
  name:          string;
  priority:      number;
  status:        string;
  conditions:    { priority: string; category: string; vip: string };
  assignment:    any;
  match_count:   number | null;
}

export interface AssignResult {
  rule_id:       string;
  rule_name:     string;
  assigned_user_id: string | null;
}

// ─── OOO check ───────────────────────────────────────────────────────────
//
// A workspace_members row carries ooo_from / ooo_to dates. Today inside
// [from, to] (inclusive) → OOO. ooo_to null means open-ended (still
// active OOO).
function isOOO(member: { ooo_from: string | null; ooo_to: string | null }): boolean {
  if (!member.ooo_from) return false;
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (todayKey < member.ooo_from) return false;
  if (member.ooo_to && todayKey > member.ooo_to) return false;
  return true;
}

// ─── Condition matching ──────────────────────────────────────────────────
function ruleMatches(rule: Rule, ticket: any, customerVip: string | null): boolean {
  const c = rule.conditions || {};
  if (c.priority && c.priority !== 'all' && c.priority !== ticket.priority_key) return false;
  if (c.category && c.category !== 'all' && c.category !== ticket.category_key) return false;
  if (c.vip      && c.vip      !== 'all' && c.vip      !== customerVip)         return false;
  return true;
}

// ─── Pick logic per mode ─────────────────────────────────────────────────
//
// Returns { userId, rrIndexNext? } — the picked agent's UUID plus the
// updated rr_index for round-robin rules (so the caller can persist it).
// Returns null if no eligible agent exists (e.g. whole team is OOO).
async function pickAssignee(args: {
  workspaceId:  string;
  rule:         Rule;
}): Promise<{ userId: string; rrIndexNext?: number } | null> {
  const { workspaceId, rule } = args;
  const sql = getDb();
  const a = rule.assignment || {};

  if (a.mode === 'specific-agent') {
    if (!a.agent_user_id) return null;
    // Verify membership + active + not OOO.
    const [m] = await sql<{ user_id: string; active: boolean; ooo_from: string | null; ooo_to: string | null }[]>`
      select user_id, active, ooo_from, ooo_to from workspace_members
      where workspace_id = ${workspaceId} and user_id = ${a.agent_user_id}
    `;
    if (!m || !m.active || isOOO(m)) return null;
    return { userId: m.user_id };
  }

  // Team-based modes (round-robin, least-busy) need the team members.
  const teamIds: string[] = Array.isArray(a.team_user_ids) ? a.team_user_ids : [];
  if (teamIds.length === 0) return null;

  const members = await sql<{ user_id: string; active: boolean; ooo_from: string | null; ooo_to: string | null }[]>`
    select user_id, active, ooo_from, ooo_to from workspace_members
    where workspace_id = ${workspaceId} and user_id = any(${teamIds})
  `;

  const eligible = [...members].filter((m) => m.active && !isOOO(m));
  if (eligible.length === 0) return null;
  const eligibleSet = new Set(eligible.map((m) => m.user_id));

  if (a.mode === 'round-robin') {
    // Walk the configured team order starting at rr_index, return the
    // first eligible user. Persist rr_index forward by one slot.
    const start = Number.isInteger(a.rr_index) ? a.rr_index : 0;
    for (let i = 0; i < teamIds.length; i++) {
      const idx = (start + i) % teamIds.length;
      const candidate = teamIds[idx];
      if (eligibleSet.has(candidate)) {
        return { userId: candidate, rrIndexNext: (idx + 1) % teamIds.length };
      }
    }
    return null;
  }

  if (a.mode === 'least-busy') {
    // Count open + escalated tickets per eligible user. Tie-break by
    // the team's configured order (stable for the same input set).
    const eligibleIds = eligible.map((m) => m.user_id);
    const tickets = await sql<{ assigned_user_id: string | null }[]>`
      select assigned_user_id from tickets
      where workspace_id = ${workspaceId} and assigned_user_id = any(${eligibleIds})
        and status_key in ('open', 'escalated') and deleted_at is null
    `;
    const counts: Record<string, number> = {};
    for (const id of eligibleIds) counts[id] = 0;
    for (const t of tickets) {
      if (t.assigned_user_id) counts[t.assigned_user_id] = (counts[t.assigned_user_id] || 0) + 1;
    }
    // Pick min, with the team's declared order as the tie-breaker.
    let bestId: string | null = null;
    let bestCount = Infinity;
    for (const id of teamIds) {
      if (!eligibleSet.has(id)) continue;
      if (counts[id] < bestCount) {
        bestId = id;
        bestCount = counts[id];
      }
    }
    return bestId ? { userId: bestId } : null;
  }

  return null;
}

// ─── Engine entry point ──────────────────────────────────────────────────
//
// Loads active rules sorted by priority asc, walks them looking for the
// first match whose assignee can actually be picked (not OOO, etc.).
// On a successful pick: updates the ticket's assigned_user_id, bumps
// the rule's match_count + last_match_at + rr_index (if round-robin).
//
// Returns the matched rule + assignee, or null if nothing applied.

export async function applyAssignmentRules(args: {
  workspaceId:  string;
  ticketId:     string;
}): Promise<AssignResult | null> {
  const { workspaceId, ticketId } = args;
  const sql = getDb();

  const [ticket] = await sql<{ status_key: string; priority_key: string | null; category_key: string | null; customer_id: string | null; assigned_user_id: string | null }[]>`
    select status_key, priority_key, category_key, customer_id, assigned_user_id from tickets
    where id = ${ticketId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!ticket) return null;

  // VIP tier is a per-customer attribute used by some rules.
  let customerVip: string | null = null;
  if (ticket.customer_id) {
    const [c] = await sql<{ vip_tier: string | null }[]>`select vip_tier from customers where id = ${ticket.customer_id}`;
    customerVip = c?.vip_tier || null;
  }

  const rules = await sql<Rule[]>`
    select id, display_id, name, priority, status, conditions, assignment, match_count from assign_rules
    where workspace_id = ${workspaceId} and status = 'active'
    order by priority asc
  `;

  for (const rule of rules) {
    if (!ruleMatches(rule, ticket, customerVip)) continue;
    const pick = await pickAssignee({ workspaceId, rule });
    if (!pick) continue;

    // 1. Update the ticket assignee. Skip the write if it already matches.
    if (ticket.assigned_user_id !== pick.userId) {
      await sql`update tickets set assigned_user_id = ${pick.userId} where id = ${ticketId} and workspace_id = ${workspaceId}`;
    }

    // 2. Bump rule bookkeeping. rr_index merges into the assignment jsonb.
    const nextAssignment = pick.rrIndexNext !== undefined
      ? { ...rule.assignment, rr_index: pick.rrIndexNext }
      : rule.assignment;
    await sql`
      update assign_rules
      set match_count = ${(rule.match_count || 0) + 1}, last_match_at = now(), assignment = ${sql.json(nextAssignment)}
      where id = ${rule.id}
    `;

    return {
      rule_id:          rule.id,
      rule_name:        rule.name,
      assigned_user_id: pick.userId,
    };
  }
  return null;
}
