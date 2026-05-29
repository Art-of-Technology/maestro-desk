import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';

export const workspace = new Hono();

workspace.use('*', requireAuth);

// ─── GET /api/v1/workspace/settings ─────────────────────────────────────
//
// Returns the workspace-level flags an agent can read (and admins can
// edit through the PATCH below). Kept narrow — sensitive columns like
// ai_credits_micro stay on the god endpoints.
workspace.get('/settings', async (c) => {
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');
  const { data, error } = await sb
    .from('workspaces')
    .select('id, name, slug, auto_priority_bump_on_angry, csat_reminder_days')
    .eq('id', workspaceId)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data)  return c.json({ error: 'Workspace not found' }, 404);
  return c.json({ workspace: data });
});

// ─── PATCH /api/v1/workspace/settings ───────────────────────────────────
//
// Admin-only writes. We use the service-role client for the actual
// UPDATE because the workspaces table only has a SELECT policy under
// the JWT-claim regime today — a workspace-admin-write policy + a
// matching sbUser flip would be a separate slice. The admin check
// runs via the existing is_workspace_admin helper, called as an RPC
// against the sbUser client so the JWT context drives the decision.
// csat_reminder_days validation: 0–6 entries, each 1–365 days,
// strictly ascending. The DB CHECK enforces length only; ordering +
// per-element bounds live here so a clean 400 surfaces in the SPA
// instead of an opaque postgres error. Empty array is valid and
// means "no reminders" for that workspace.
const SettingsBody = z.object({
  auto_priority_bump_on_angry: z.boolean().optional(),
  csat_reminder_days: z.array(z.number().int().min(1).max(365))
    .max(6)
    .refine(
      (arr) => arr.every((v, i) => i === 0 || v > arr[i - 1]),
      'csat_reminder_days must be strictly ascending',
    )
    .optional(),
}).strict();

workspace.patch('/settings', async (c) => {
  const sbUser  = c.get('sbUser');
  const sbAdmin = c.get('sb');
  const workspaceId = c.get('workspaceId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = SettingsBody.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: 'No fields to update' }, 400);

  const { data: isAdmin, error: rpcErr } = await sbUser.rpc('is_workspace_admin', { ws: workspaceId });
  if (rpcErr) return c.json({ error: rpcErr.message }, 500);
  if (!isAdmin) return c.json({ error: 'Admin permission required' }, 403);

  const { data, error } = await sbAdmin
    .from('workspaces')
    .update(parsed.data)
    .eq('id', workspaceId)
    .select('id, name, slug, auto_priority_bump_on_angry, csat_reminder_days')
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data)  return c.json({ error: 'Workspace not found' }, 404);
  return c.json({ workspace: data });
});
