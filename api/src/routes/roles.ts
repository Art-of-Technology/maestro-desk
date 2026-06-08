import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';
import { getDb } from '../lib/db.ts';

// Migration to Neon — Step 3. Member-level (the original roles RLS was
// `using (workspace_id = current_workspace_id())` — any workspace member),
// workspace-scoped via getDb(). Multi-table writes run in transactions.
export const roles = new Hono();

roles.use('*', requireAuth);

const RoleBody = z.object({
  name:        z.string().min(1).max(100),
  is_admin:    z.boolean().optional(),
  permissions: z.array(z.string().min(1).max(64)).optional(),
});

// ─── GET / — list workspace roles with their granted permission keys ─────
roles.get('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const rows = await sql`
    select r.id, r.name, r.is_admin,
           coalesce(array_agg(rp.permission_key) filter (where rp.permission_key is not null), '{}') as permissions
    from roles r
    left join role_permissions rp on rp.role_id = r.id
    where r.workspace_id = ${workspaceId}
    group by r.id, r.name, r.is_admin
    order by r.name asc
  `;
  return c.json({ roles: rows });
});

// ─── POST / — create role with optional permissions[] ────────────────────
roles.post('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = RoleBody.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  const input = parsed.data;
  const perms = input.permissions ?? [];

  try {
    const role = await sql.begin(async (tx) => {
      const [r] = await tx`
        insert into roles (workspace_id, name, is_admin)
        values (${workspaceId}, ${input.name}, ${input.is_admin ?? false})
        returning id, name, is_admin
      `;
      if (perms.length > 0) {
        await tx`insert into role_permissions ${tx(perms.map((key) => ({ role_id: r.id, permission_key: key })))}`;
      }
      return r;
    });
    return c.json({ role: { ...role, permissions: perms } }, 201);
  } catch (err) {
    if ((err as any)?.code === '23505') return c.json({ error: 'Role name already exists' }, 409);
    if ((err as any)?.code === '23503') return c.json({ error: 'Unknown permission key' }, 400);
    throw err;
  }
});

// ─── PATCH /:id — rename, change is_admin, or replace permission set ─────
// permissions[] (when present) is a REPLACE.
const PatchRole = z.object({
  name:        z.string().min(1).max(100).optional(),
  is_admin:    z.boolean().optional(),
  permissions: z.array(z.string().min(1).max(64)).optional(),
}).strict();

roles.patch('/:id', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PatchRole.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: 'No fields to update' }, 400);

  const roleUpdates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined)     roleUpdates.name     = parsed.data.name;
  if (parsed.data.is_admin !== undefined) roleUpdates.is_admin = parsed.data.is_admin;

  try {
    const result = await sql.begin(async (tx) => {
      const [existing] = await tx`
        select id from roles where id = ${id} and workspace_id = ${workspaceId} for update
      `;
      if (!existing) return null;

      if (Object.keys(roleUpdates).length > 0) {
        await tx`update roles set ${tx(roleUpdates)} where id = ${id} and workspace_id = ${workspaceId}`;
      }
      if (parsed.data.permissions !== undefined) {
        await tx`delete from role_permissions where role_id = ${id}`;
        if (parsed.data.permissions.length > 0) {
          await tx`insert into role_permissions ${tx(parsed.data.permissions.map((key) => ({ role_id: id, permission_key: key })))}`;
        }
      }
      const [r] = await tx`
        select r.id, r.name, r.is_admin,
               coalesce(array_agg(rp.permission_key) filter (where rp.permission_key is not null), '{}') as permissions
        from roles r
        left join role_permissions rp on rp.role_id = r.id
        where r.id = ${id}
        group by r.id, r.name, r.is_admin
      `;
      return r;
    });
    if (!result) return c.json({ error: 'Role not found' }, 404);
    return c.json({ role: result });
  } catch (err) {
    if ((err as any)?.code === '23505') return c.json({ error: 'Role name already exists' }, 409);
    if ((err as any)?.code === '23503') return c.json({ error: 'Unknown permission key' }, 400);
    throw err;
  }
});

// ─── DELETE /:id — refuse if any workspace_members reference it ──────────
roles.delete('/:id', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const [{ count }] = await sql`
    select count(*)::int from workspace_members where workspace_id = ${workspaceId} and role_id = ${id}
  `;
  if (count > 0) {
    return c.json({ error: `${count} member(s) still assigned to this role` }, 409);
  }

  await sql`delete from roles where id = ${id} and workspace_id = ${workspaceId}`;
  return new Response(null, { status: 204 });
});
