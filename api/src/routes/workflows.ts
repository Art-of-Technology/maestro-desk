import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';
import { getDb } from '../lib/db.ts';

// Migration to Neon — Step 3. Member-level, workspace-scoped CRUD via getDb().
export const workflows = new Hono();

workflows.use('*', requireAuth);

function nextDisplayId(): string {
  return `WF-${String(Math.floor(Math.random() * 9000 + 1000))}`;
}

// trigger / action live as jsonb so future structured-rule storage works
// without a schema change. The v1 SPA models them as freeform text, so we
// wrap as { text: "..." } on the wire.
const WorkflowBody = z.object({
  name:    z.string().min(1).max(200),
  trigger: z.string().min(1).max(1000),
  action:  z.string().min(1).max(1000),
  status:  z.enum(['active', 'inactive']).optional(),
});

workflows.get('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const rows = await sql`
    select id, display_id, name, trigger, action, status, run_count, last_run_at, created_at, updated_at
    from workflows
    where workspace_id = ${workspaceId}
    order by display_id asc
  `;
  return c.json({ workflows: rows });
});

workflows.post('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = WorkflowBody.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  try {
    const [row] = await sql`
      insert into workflows (workspace_id, display_id, name, trigger, action, status)
      values (${workspaceId}, ${nextDisplayId()}, ${input.name},
              ${sql.json({ text: input.trigger })}, ${sql.json({ text: input.action })}, ${input.status ?? 'active'})
      returning id, display_id, name, trigger, action, status, run_count, last_run_at, created_at, updated_at
    `;
    return c.json({ workflow: row }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

const PatchWorkflow = z.object({
  name:    z.string().min(1).max(200).optional(),
  trigger: z.string().min(1).max(1000).optional(),
  action:  z.string().min(1).max(1000).optional(),
  status:  z.enum(['active', 'inactive']).optional(),
}).strict();

workflows.patch('/:id', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PatchWorkflow.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }

  const sets = [];
  if (parsed.data.name    !== undefined) sets.push(sql`name = ${parsed.data.name}`);
  if (parsed.data.status  !== undefined) sets.push(sql`status = ${parsed.data.status}`);
  if (parsed.data.trigger !== undefined) sets.push(sql`trigger = ${sql.json({ text: parsed.data.trigger })}`);
  if (parsed.data.action  !== undefined) sets.push(sql`action = ${sql.json({ text: parsed.data.action })}`);
  if (sets.length === 0) return c.json({ error: 'No fields to update' }, 400);

  const [row] = await sql`
    update workflows set ${sets.reduce((acc, s, i) => (i ? sql`${acc}, ${s}` : s))}
    where id = ${id} and workspace_id = ${workspaceId}
    returning id, display_id, name, trigger, action, status, run_count, last_run_at, updated_at
  `;
  if (!row) return c.json({ error: 'Workflow not found' }, 404);
  return c.json({ workflow: row });
});

workflows.delete('/:id', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  await sql`delete from workflows where id = ${id} and workspace_id = ${workspaceId}`;
  return new Response(null, { status: 204 });
});

// ─── POST /:id/run — manual run (bumps counters, logs a workflow_runs row) ──
// v1 doesn't execute the workflow (no rules engine yet) — just records the
// manual trigger so the run-history pane reflects it.
workflows.post('/:id/run', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const id = c.req.param('id');

  const [wf] = await sql`
    select id, run_count from workflows where id = ${id} and workspace_id = ${workspaceId}
  `;
  if (!wf) return c.json({ error: 'Workflow not found' }, 404);

  const [updated] = await sql`
    update workflows set run_count = ${(wf.run_count || 0) + 1}, last_run_at = now()
    where id = ${id} and workspace_id = ${workspaceId}
    returning id, run_count, last_run_at
  `;

  // Best-effort run record — failure doesn't roll back the counter bump.
  try {
    await sql`
      insert into workflow_runs (workspace_id, workflow_id, kind, triggered_by_user_id)
      values (${workspaceId}, ${id}, 'manual', ${userId})
    `;
  } catch (err) {
    console.warn('[workflows] workflow_runs insert failed:', err instanceof Error ? err.message : err);
  }

  return c.json({ workflow: updated });
});

// ─── GET /:id/runs — run history, newest first (joined for display names) ──
workflows.get('/:id/runs', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const [wf] = await sql`select id from workflows where id = ${id} and workspace_id = ${workspaceId}`;
  if (!wf) return c.json({ error: 'Workflow not found' }, 404);

  const rows = await sql`
    select wr.id, wr.kind, wr.triggered_by_user_id, wr.ticket_id, wr.created_at,
           u.name as triggered_by_name, t.display_id as ticket_display_id
    from workflow_runs wr
    left join users u on u.id = wr.triggered_by_user_id
    left join tickets t on t.id = wr.ticket_id
    where wr.workspace_id = ${workspaceId} and wr.workflow_id = ${id}
    order by wr.created_at desc
    limit 200
  `;
  const runs = rows.map((r) => ({
    id:                   r.id,
    kind:                 r.kind,
    triggered_by_user_id: r.triggered_by_user_id,
    triggered_by_name:    r.triggered_by_name ?? null,
    ticket_id:            r.ticket_id,
    ticket_display_id:    r.ticket_display_id ?? null,
    created_at:           r.created_at,
  }));
  return c.json({ runs });
});
