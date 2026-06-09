import { getDb } from './db.ts';

// Migration to Neon — Step 3 (tickets megabatch). DB via getDb().

// ─── Trigger evaluation ──────────────────────────────────────────────────
//
// Predicate shape: { field, op, value }. Aggregator shape: { all: [...] }
// or { any: [...] }. v1 only handles equality predicates against ticket
// columns we map below. Time-based fields (`age_hours`, `last_updated_*`)
// are NOT evaluated — they require a periodic scan that isn't wired yet,
// so a trigger that includes one of them will never match. The engine
// just returns false for unknown fields, the rule sits quiet.

interface Predicate {
  field: string;
  op:    string;
  value: unknown;
}

// Map predicate field names → row column names. The seed uses short names
// like `priority` / `category`; our schema uses the `_key` suffix.
const FIELD_TO_COLUMN: Record<string, string> = {
  priority:        'priority_key',
  category:        'category_key',
  status:          'status_key',
  customer_id:     'customer_id',
  assigned_user_id:'assigned_user_id',
  sla_state:       'sla_state',
};

// Change-detection fields — `status_change` matches when status_key
// transitioned in this PATCH. Value is the NEW key when the column
// changed, else null. Used by triggers like "Status changed to Resolved".
const CHANGE_FIELDS: Record<string, string> = {
  status_change:   'status_key',
  priority_change: 'priority_key',
  category_change: 'category_key',
  assignee_change: 'assigned_user_id',
};

function evaluatePredicate(p: Predicate, row: Record<string, unknown>, changes: Record<string, unknown>): boolean {
  // Change-field predicates: match against the changes map. `to` op
  // matches when the column moved to the given value; `eq` is treated
  // the same way for ergonomics (some seeds use `eq`, the WF-004 seed
  // uses `to`).
  if (p.field in CHANGE_FIELDS) {
    const ch = changes[p.field];
    if (ch === undefined) return false; // field didn't change in this PATCH
    switch (p.op) {
      case 'to':
      case 'eq':  return ch === p.value;
      case 'neq': return ch !== p.value;
      default:    return false;
    }
  }
  // Plain state-field predicates.
  const col = FIELD_TO_COLUMN[p.field];
  if (!col) return false;
  const actual = row[col];
  switch (p.op) {
    case 'eq':  return actual === p.value;
    case 'neq': return actual !== p.value;
    default:    return false;
  }
}

export function evaluateTrigger(trigger: unknown, row: Record<string, unknown>, changes: Record<string, unknown> = {}): boolean {
  if (!trigger || typeof trigger !== 'object') return false;
  const t = trigger as Record<string, unknown>;
  if (Array.isArray(t.all)) return (t.all as Predicate[]).every((p) => evaluatePredicate(p, row, changes));
  if (Array.isArray(t.any)) return (t.any as Predicate[]).some((p) => evaluatePredicate(p, row, changes));
  return false;
}

// ─── Action execution ────────────────────────────────────────────────────
//
// Each action mutates the ticket (or sibling rows). `then` chains one
// follow-up — useful for "assign + notify". Deeper chains supported too:
// recurse on each `then` until null/undefined.
//
// notify / flag are logged in the audit events table only — there's no
// notification dispatcher yet, so these act as audit-trail no-ops.

interface ActionContext {
  workspaceId:  string;
  ticketId:     string;
  workflowId:   string;
  workflowName: string;
}

async function executeAction(action: any, ctx: ActionContext): Promise<void> {
  if (!action || typeof action !== 'object' || typeof action.type !== 'string') return;
  const { workspaceId, ticketId } = ctx;
  const sql = getDb();

  switch (action.type) {
    case 'set_status':
      await sql`update tickets set status_key = ${action.value} where id = ${ticketId} and workspace_id = ${workspaceId}`;
      break;

    case 'set_priority':
      await sql`update tickets set priority_key = ${action.value} where id = ${ticketId} and workspace_id = ${workspaceId}`;
      break;

    case 'add_tag': {
      const tag = String(action.value || '').trim().toLowerCase();
      if (!tag) break;
      await sql`
        insert into ticket_tags (workspace_id, ticket_id, tag) values (${workspaceId}, ${ticketId}, ${tag})
        on conflict (ticket_id, tag) do nothing
      `;
      await sql`
        insert into tag_library (workspace_id, tag, kind) values (${workspaceId}, ${tag}, 'manual')
        on conflict (workspace_id, tag) do nothing
      `;
      break;
    }

    case 'assign_role': {
      // First active member with the named role — no tie-break (the
      // assignment-rules engine handles that and can still run on top).
      const [member] = await sql<{ user_id: string }[]>`
        select wm.user_id
        from workspace_members wm
        join roles r on r.id = wm.role_id
        where wm.workspace_id = ${workspaceId} and r.name = ${action.role} and wm.active = true
        limit 1
      `;
      if (!member) break;
      await sql`update tickets set assigned_user_id = ${member.user_id} where id = ${ticketId} and workspace_id = ${workspaceId}`;
      break;
    }

    case 'notify':
    case 'flag': {
      // Audit-only for v1 — visible in the god panel independently of workflow_runs.
      await sql`
        insert into audit_events (workspace_id, action, target_type, target_id, metadata)
        values (${workspaceId}, ${`workflow.${action.type}`}, 'ticket', ${ticketId},
          ${sql.json({ workflow_id: ctx.workflowId, workflow_name: ctx.workflowName, target: action.target ?? null })})
      `;
      break;
    }

    default:
      // Unknown action type — log and move on. Future engine versions
      // will pick these up.
      console.warn(`[workflow-engine] unknown action type: ${action.type}`);
  }

  if (action.then) await executeAction(action.then, ctx);
}

// ─── Engine entry point ──────────────────────────────────────────────────
//
// Called from ticket-mutation routes after the user's PATCH lands.
// Loads all active workflows for the workspace, evaluates each against
// the post-update ticket row, and runs the action of every match. Each
// match bumps run_count + last_run_at on the workflow and writes a
// workflow_runs row (kind='triggered') so the run-history pane shows
// what happened.
//
// Errors during a single workflow's execution are swallowed (logged) so
// one bad rule can't break the rest. The caller is the user's mutation
// path — we don't want a notify-target lookup failure to fail the user's
// PATCH.

export async function runWorkflowsForTicket(args: {
  workspaceId:  string;
  ticketId:     string;
  // Optional pre-update row — when present, change-detection triggers
  // (status_change / priority_change / category_change / assignee_change)
  // can fire. Callers that don't have a before-state can pass null /
  // omit it; only field-state triggers will fire then.
  prevRow?:     Record<string, unknown> | null;
}): Promise<void> {
  const { workspaceId, ticketId, prevRow } = args;
  const sql = getDb();

  // Pull the post-update ticket row so the trigger evaluates against
  // what the API just wrote, not what the caller sent.
  const [row] = await sql<Record<string, unknown>[]>`
    select id, status_key, priority_key, category_key, customer_id, assigned_user_id, sla_state
    from tickets where id = ${ticketId} and workspace_id = ${workspaceId}
  `;
  if (!row) return;

  // Build the changes map: { status_change: 'resolved', ... } only for
  // columns that actually changed in this PATCH.
  const changes: Record<string, unknown> = {};
  if (prevRow) {
    for (const [changeField, col] of Object.entries(CHANGE_FIELDS)) {
      if ((prevRow as any)[col] !== (row as any)[col]) {
        changes[changeField] = (row as any)[col];
      }
    }
  }

  const workflows = await sql<{ id: string; name: string; trigger: unknown; action: unknown; run_count: number }[]>`
    select id, name, trigger, action, run_count from workflows
    where workspace_id = ${workspaceId} and status = 'active'
  `;

  for (const wf of workflows) {
    if (!evaluateTrigger(wf.trigger, row, changes)) continue;
    try {
      await executeAction(wf.action, {
        workspaceId,
        ticketId,
        workflowId:   wf.id,
        workflowName: wf.name,
      });
      // Bump counters + audit. Best-effort; errors logged but don't break
      // the loop so a later workflow still gets its chance.
      await sql`update workflows set run_count = ${(wf.run_count || 0) + 1}, last_run_at = now() where id = ${wf.id}`;
      await sql`
        insert into workflow_runs (workspace_id, workflow_id, ticket_id, kind)
        values (${workspaceId}, ${wf.id}, ${ticketId}, 'triggered')
      `;
    } catch (err) {
      console.error(`[workflow-engine] workflow ${wf.id} failed:`, err);
    }
  }
}
