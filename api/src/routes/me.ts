import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';
import { getDb } from '../lib/db.ts';

// Migration to Neon — Step 3. The caller's own profile + active-workspace
// membership. Scoped to userId/workspaceId from the auth middleware (the
// per-user gate the RLS self-policies provided).
export const me = new Hono();

me.use('*', requireAuth);

me.get('/', async (c) => {
  const sql = getDb();
  const userId = c.get('userId');
  const workspaceId = c.get('workspaceId');

  const [user] = await sql`
    select id, email, name, initials, is_platform_admin, mention_email_enabled
    from users where id = ${userId}
  `;
  if (!user) return c.json({ error: 'User not found' }, 404);

  const [membership] = await sql`
    select wm.role_id, wm.active, wm.ooo_from, wm.ooo_to, wm.ooo_note,
           json_build_object('name', r.name, 'is_admin', r.is_admin) as roles
    from workspace_members wm
    left join roles r on r.id = wm.role_id
    where wm.user_id = ${userId} and wm.workspace_id = ${workspaceId}
  `;
  const [workspace] = await sql`
    select id, name, slug, logo_url, primary_color from workspaces where id = ${workspaceId}
  `;

  return c.json({ user, workspace_id: workspaceId, workspace: workspace ?? null, membership: membership ?? null });
});

// Self-PATCH for the small set of fields a user can edit on their own row.
// Scoped to id = userId — a user can only ever update their own row.
const MePatch = z.object({
  mention_email_enabled: z.boolean().optional(),
}).strict();

me.patch('/', async (c) => {
  const sql = getDb();
  const userId = c.get('userId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = MePatch.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: 'No fields to update' }, 400);

  const [user] = await sql`
    update users set ${sql(parsed.data)}
    where id = ${userId}
    returning id, email, name, initials, is_platform_admin, mention_email_enabled
  `;
  if (!user) return c.json({ error: 'User not found' }, 404);
  return c.json({ user });
});
