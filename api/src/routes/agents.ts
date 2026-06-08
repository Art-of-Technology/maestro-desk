import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';
import { getDb } from '../lib/db.ts';
import { requireWorkspaceAdmin } from '../lib/authz.ts';

// Migration to Neon — Step 3. workspace_members management.
//   GET    — list (any member; mirrors workspace_members_visible RLS)
//   PATCH  — reassign role / activate / OOO (ADMIN only; replaces the
//            workspace_members_admin_update RLS policy via requireWorkspaceAdmin)
//   DELETE — remove membership (ADMIN only)
export const agents = new Hono();

agents.use('*', requireAuth);

// Joined membership shape (users + roles nested, matching the old PostgREST
// embed the SPA consumes). Soft-deleted users are excluded.
const AGENT_SELECT = (sql: ReturnType<typeof getDb>, workspaceId: string, userId?: string) => sql`
  select wm.user_id, wm.role_id, wm.active, wm.ooo_from, wm.ooo_to, wm.ooo_note, wm.joined_at,
         json_build_object('id', u.id, 'name', u.name, 'initials', u.initials, 'email', u.email) as users,
         case when r.id is null then null
              else json_build_object('name', r.name, 'is_admin', r.is_admin) end as roles
  from workspace_members wm
  join users u on u.id = wm.user_id and u.deleted_at is null
  left join roles r on r.id = wm.role_id
  where wm.workspace_id = ${workspaceId}
    ${userId ? sql`and wm.user_id = ${userId}` : sql``}
  order by wm.joined_at asc
`;

agents.get('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const agents = await AGENT_SELECT(sql, workspaceId);
  return c.json({ agents });
});

// ─── PATCH /:userId — update a workspace_members row (admin only) ────────
const PatchAgent = z.object({
  role_id:  z.string().uuid().optional(),
  active:   z.boolean().optional(),
  ooo_from: z.string().nullable().optional(),
  ooo_to:   z.string().nullable().optional(),
  ooo_note: z.string().nullable().optional(),
}).strict();

agents.patch('/:userId', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const targetUserId = c.req.param('userId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PatchAgent.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: 'No fields to update' }, 400);

  // Confirm the target role belongs to this workspace (no cross-tenant FK).
  if (parsed.data.role_id !== undefined) {
    const [role] = await sql`select id from roles where id = ${parsed.data.role_id} and workspace_id = ${workspaceId}`;
    if (!role) return c.json({ error: 'Role not found in this workspace' }, 400);
  }

  const [updated] = await sql`
    update workspace_members set ${sql(parsed.data)}
    where workspace_id = ${workspaceId} and user_id = ${targetUserId}
    returning user_id
  `;
  if (!updated) return c.json({ error: 'Membership not found' }, 404);

  const [agent] = await AGENT_SELECT(sql, workspaceId, targetUserId);
  return c.json({ agent });
});

// ─── DELETE /:userId — remove membership (admin only) ───────────────────
// Hard-delete from workspace_members; the users row stays so historical
// references (ticket_messages.author_user_id) keep resolving.
agents.delete('/:userId', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const targetUserId = c.req.param('userId');

  await sql`delete from workspace_members where workspace_id = ${workspaceId} and user_id = ${targetUserId}`;
  return new Response(null, { status: 204 });
});
