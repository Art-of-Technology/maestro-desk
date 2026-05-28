import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';

export const workflows = new Hono();

workflows.use('*', requireAuth);

// Display-id allocator — same placeholder as tickets. Replace with a
// per-workspace sequence before real-customer scale.
function nextDisplayId(): string {
  return `WF-${String(Math.floor(Math.random() * 9000 + 1000))}`;
}

// trigger / action live as JSONB so future structured-rule storage works
// without a schema change. The v1 SPA models them as freeform text, so we
// wrap as { text: "..." } on the wire — the column type accepts the
// richer shape transparently when the rules engine lands.
const WorkflowBody = z.object({
  name:    z.string().min(1).max(200),
  trigger: z.string().min(1).max(1000),
  action:  z.string().min(1).max(1000),
  status:  z.enum(['active', 'inactive']).optional(),
});

// ─── GET / — list ─────────────────────────────────────────────────────────
workflows.get('/', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');

  const { data, error } = await sb
    .from('workflows')
    .select('id, display_id, name, trigger, action, status, run_count, last_run_at, created_at, updated_at')
    .eq('workspace_id', workspaceId)
    .order('display_id', { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ workflows: data });
});

// ─── POST / — create ──────────────────────────────────────────────────────
workflows.post('/', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = WorkflowBody.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  const { data, error } = await sb
    .from('workflows')
    .insert({
      workspace_id: workspaceId,
      display_id:   nextDisplayId(),
      name:         input.name,
      trigger:      { text: input.trigger },
      action:       { text: input.action },
      status:       input.status ?? 'active',
    })
    .select('id, display_id, name, trigger, action, status, run_count, last_run_at, created_at, updated_at')
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ workflow: data }, 201);
});

// ─── PATCH /:id — edit or toggle ──────────────────────────────────────────
const PatchWorkflow = z.object({
  name:    z.string().min(1).max(200).optional(),
  trigger: z.string().min(1).max(1000).optional(),
  action:  z.string().min(1).max(1000).optional(),
  status:  z.enum(['active', 'inactive']).optional(),
}).strict();

workflows.patch('/:id', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PatchWorkflow.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined)    updates.name    = parsed.data.name;
  if (parsed.data.status !== undefined)  updates.status  = parsed.data.status;
  if (parsed.data.trigger !== undefined) updates.trigger = { text: parsed.data.trigger };
  if (parsed.data.action !== undefined)  updates.action  = { text: parsed.data.action };
  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  const { data, error } = await sb
    .from('workflows')
    .update(updates)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select('id, display_id, name, trigger, action, status, run_count, last_run_at, updated_at')
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data)  return c.json({ error: 'Workflow not found' }, 404);
  return c.json({ workflow: data });
});

// ─── DELETE /:id — remove ─────────────────────────────────────────────────
workflows.delete('/:id', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const { error } = await sb
    .from('workflows')
    .delete()
    .eq('id', id)
    .eq('workspace_id', workspaceId);
  if (error) return c.json({ error: error.message }, 500);
  return new Response(null, { status: 204 });
});

// ─── POST /:id/run — manual run (increments counters, logs the event) ────
//
// v1 doesn't actually execute the workflow — there's no rules engine yet.
// The endpoint just bumps run_count + last_run_at + writes a workflow_runs
// row so the run history pane reflects manual triggers. When the engine
// lands, the actual triggered effects can plug into this same row stream
// without changing the wire shape.
workflows.post('/:id/run', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const id = c.req.param('id');

  const { data: wf, error: lookupErr } = await sb
    .from('workflows')
    .select('id, run_count')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (lookupErr) return c.json({ error: lookupErr.message }, 500);
  if (!wf) return c.json({ error: 'Workflow not found' }, 404);

  const now = new Date().toISOString();
  const { data: updated, error: updErr } = await sb
    .from('workflows')
    .update({ run_count: (wf.run_count || 0) + 1, last_run_at: now })
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select('id, run_count, last_run_at')
    .single();
  if (updErr) return c.json({ error: updErr.message }, 500);

  // Best-effort run record. Failure here doesn't roll back the counter —
  // the counter bump is the visible thing, the history row is the trail.
  const { error: runErr } = await sb
    .from('workflow_runs')
    .insert({
      workspace_id:         workspaceId,
      workflow_id:          id,
      kind:                 'manual',
      triggered_by_user_id: userId,
    });
  if (runErr) console.warn('[workflows] workflow_runs insert failed:', runErr.message);

  return c.json({ workflow: updated });
});

// ─── GET /:id/runs — workflow run history, newest first ─────────────────
//
// Joined with users (for the triggered-by display name) and tickets
// (for the display_id when the run was tied to a ticket — triggered
// runs always are, manual runs aren't). Capped at 200 rows so the UI
// doesn't render an unbounded list.
workflows.get('/:id/runs', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  // Workspace-scope check.
  const { data: wf, error: wErr } = await sb
    .from('workflows')
    .select('id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (wErr) return c.json({ error: wErr.message }, 500);
  if (!wf)  return c.json({ error: 'Workflow not found' }, 404);

  const { data, error } = await sb
    .from('workflow_runs')
    .select(`
      id, kind, triggered_by_user_id, ticket_id, created_at,
      users(name),
      tickets(display_id)
    `)
    .eq('workspace_id', workspaceId)
    .eq('workflow_id', id)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return c.json({ error: error.message }, 500);

  const runs = (data || []).map((r: any) => ({
    id:                   r.id,
    kind:                 r.kind,
    triggered_by_user_id: r.triggered_by_user_id,
    triggered_by_name:    r.users?.name || null,
    ticket_id:            r.ticket_id,
    ticket_display_id:    r.tickets?.display_id || null,
    created_at:           r.created_at,
  }));
  return c.json({ runs });
});
