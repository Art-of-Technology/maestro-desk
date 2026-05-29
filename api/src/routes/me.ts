import { Hono } from 'hono';
import { z } from 'zod';
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
    .select('id, email, name, initials, is_platform_admin, mention_email_enabled')
    .eq('id', userId)
    .single();
  if (uErr) return c.json({ error: uErr.message }, 500);

  const [memRes, wsRes] = await Promise.all([
    sb.from('workspace_members')
      .select('role_id, active, ooo_from, ooo_to, ooo_note, roles(name, is_admin)')
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId)
      .single(),
    sb.from('workspaces')
      .select('id, name, slug, logo_url, primary_color')
      .eq('id', workspaceId)
      .maybeSingle(),
  ]);
  if (memRes.error) return c.json({ error: memRes.error.message }, 500);
  if (wsRes.error)  return c.json({ error: wsRes.error.message }, 500);

  return c.json({
    user,
    workspace_id: workspaceId,
    workspace:    wsRes.data,
    membership:   memRes.data,
  });
});

// Self-PATCH for the small set of fields a user can edit on their
// own row. Currently just the mention-email opt-out from PR #226
// — adding more fields here means extending the zod schema, not a
// new endpoint shape. RLS (users_self_update policy) is the gate:
// the user can only ever update their own row, regardless of what
// we put in the WHERE clause.
const MePatch = z.object({
  mention_email_enabled: z.boolean().optional(),
}).strict();

me.patch('/', async (c) => {
  const sb = c.get('sbUser');
  const userId = c.get('userId');
  const reqBody = await c.req.json().catch(() => null);
  const parsed = MePatch.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: 'No fields to update' }, 400);
  const { data, error } = await sb
    .from('users')
    .update(parsed.data)
    .eq('id', userId)
    .select('id, email, name, initials, is_platform_admin, mention_email_enabled')
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data)  return c.json({ error: 'User not found' }, 404);
  return c.json({ user: data });
});
