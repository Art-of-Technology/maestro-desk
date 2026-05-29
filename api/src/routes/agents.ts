import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';

export const agents = new Hono();

agents.use('*', requireAuth);

// List workspace_members in the active workspace, joined with users (for
// name + initials) and roles (for the role label). Returns active and
// inactive members so the agent page can show "Inactive" agents grayed-out
// the way data.js seeded `active: false` rows did.
//
// Uses sbUser (JWT-scoped) — workspace_members, users (peer-select), and
// roles policies all read is_workspace_member, so the embeds resolve
// inside the caller's workspace_ids set.
agents.get('/', async (c) => {
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');

  const { data, error } = await sb
    .from('workspace_members')
    .select(`
      user_id, role_id, active, ooo_from, ooo_to, ooo_note, joined_at,
      users!inner(id, name, initials, email),
      roles(name, is_admin)
    `)
    .eq('workspace_id', workspaceId);

  if (error) return c.json({ error: error.message }, 500);

  // Filter out membership rows whose user row is soft-deleted. PostgREST
  // returns nulls in the join when the FK target is missing, so the inner
  // join is enough — but defensive check anyway.
  const agents = (data || []).filter((m: any) => m.users);

  return c.json({ agents });
});

// ─── PATCH /:userId — update a workspace_members row ────────────────────
//
// :userId is the public.users.id (also workspace_members.user_id). The
// (workspace_id, user_id) pair is the natural key. Used for reassign-
// role, activate/deactivate, and OOO updates.
const PatchAgent = z.object({
  role_id:   z.string().uuid().optional(),
  active:    z.boolean().optional(),
  ooo_from:  z.string().nullable().optional(),
  ooo_to:    z.string().nullable().optional(),
  ooo_note:  z.string().nullable().optional(),
}).strict();

// PATCH stays on service-role: workspace_members has only a SELECT policy
// under the JWT-claim regime, and the admin-only update policy + a proper
// "caller is admin in this workspace" check belongs in its own PR rather
// than getting bolted on here.
agents.patch('/:userId', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const userId = c.req.param('userId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PatchAgent.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  // Confirm role belongs to this workspace before reassigning (otherwise
  // the FK accepts a UUID from another workspace and the row points
  // across tenancies).
  if (parsed.data.role_id !== undefined) {
    const { data: role, error: roleErr } = await sb
      .from('roles')
      .select('id')
      .eq('id', parsed.data.role_id)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (roleErr) return c.json({ error: roleErr.message }, 500);
    if (!role)   return c.json({ error: 'Role not found in this workspace' }, 400);
  }

  const { data, error } = await sb
    .from('workspace_members')
    .update(parsed.data)
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .select(`
      user_id, role_id, active, ooo_from, ooo_to, ooo_note, joined_at,
      users!inner(id, name, initials, email),
      roles(name, is_admin)
    `)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data)  return c.json({ error: 'Membership not found' }, 404);
  return c.json({ agent: data });
});

// ─── DELETE /:userId — remove workspace membership ──────────────────────
//
// Hard-delete from workspace_members. The users row stays so historical
// references (e.g. ticket_messages.author_user_id) keep resolving. Same
// shape as removing an agent from the demo persona's AGENTS array.
agents.delete('/:userId', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const userId = c.req.param('userId');

  const { error } = await sb
    .from('workspace_members')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId);
  if (error) return c.json({ error: error.message }, 500);
  return new Response(null, { status: 204 });
});
