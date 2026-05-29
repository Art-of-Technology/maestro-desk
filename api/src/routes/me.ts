import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.ts';

export const me = new Hono();

me.use('*', requireAuth);

// Returns the caller's profile + workspace membership info. Reads
// through sbUser so RLS gates everything via the JWT claims:
//   - users: users_self_select (id = auth.uid())
//   - workspace_members: workspace_members_visible (is_workspace_member)
//   - roles embed: roles_workspace_access (is_workspace_member)
me.get('/', async (c) => {
  const sb = c.get('sbUser');
  const userId = c.get('userId');
  const workspaceId = c.get('workspaceId');

  const { data: user, error: uErr } = await sb
    .from('users')
    .select('id, email, name, initials, is_platform_admin')
    .eq('id', userId)
    .single();
  if (uErr) return c.json({ error: uErr.message }, 500);

  const { data: membership, error: mErr } = await sb
    .from('workspace_members')
    .select('role_id, active, ooo_from, ooo_to, ooo_note, roles(name, is_admin)')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .single();
  if (mErr) return c.json({ error: mErr.message }, 500);

  return c.json({ user, workspace_id: workspaceId, membership });
});
