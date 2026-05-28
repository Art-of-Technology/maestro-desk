import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.ts';

export const agents = new Hono();

agents.use('*', requireAuth);

// List workspace_members in the active workspace, joined with users (for
// name + initials) and roles (for the role label). Returns active and
// inactive members so the agent page can show "Inactive" agents grayed-out
// the way data.js seeded `active: false` rows did.
agents.get('/', async (c) => {
  const sb = c.get('sb');
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
