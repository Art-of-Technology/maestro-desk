import { Hono } from 'hono';
import { requireAuthOnly } from '../middleware/auth.ts';
import { supabaseAdmin } from '../lib/supabase.ts';

export const whoami = new Hono();

whoami.use('*', requireAuthOnly);

// Returns the caller's identity — JWT-verified, no workspace context. The
// SPA hits this immediately after sign-in to (a) confirm the JWT works and
// (b) get the is_platform_admin flag to decide whether to show the god UI.
//
// /me is for workspace-scoped sessions (requires X-Workspace-Id +
// membership); /whoami is the workspace-agnostic equivalent for callers
// who haven't picked a workspace yet (platform admins) or who can't pick
// one (users without active memberships).
whoami.get('/', async (c) => {
  const userId = c.get('userId');

  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select('id, email, name, initials, is_platform_admin')
    .eq('id', userId)
    .single();
  if (error) return c.json({ error: error.message }, 500);

  return c.json({ user });
});
