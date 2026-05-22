import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.ts';
import { supabaseAdmin } from '../lib/supabase.ts';

export const me = new Hono();

me.use('*', requireAuth);

// Returns the caller's profile + workspace membership info.
me.get('/', async (c) => {
  const userId = c.get('userId');
  const workspaceId = c.get('workspaceId');

  const { data: user, error: uErr } = await supabaseAdmin
    .from('users')
    .select('id, email, name, initials, is_platform_admin')
    .eq('id', userId)
    .single();
  if (uErr) return c.json({ error: uErr.message }, 500);

  const { data: membership, error: mErr } = await supabaseAdmin
    .from('workspace_members')
    .select('role_id, active, ooo_from, ooo_to, ooo_note, roles(name, is_admin)')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .single();
  if (mErr) return c.json({ error: mErr.message }, 500);

  return c.json({ user, workspace_id: workspaceId, membership });
});
