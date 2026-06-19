import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../lib/db.js';

// Migration to Neon — Step 3. Member-level (the original roles RLS was
// `using (workspace_id = current_workspace_id())` — any workspace member),
// workspace-scoped via getDb(). Multi-table writes run in transactions.
export const roles = new Hono();

roles.use('*', requireAuth);

const RoleBody = z.object({
  name:     z.string().min(1).max(100),
  is_admin: z.boolean().optional(),
});

// ─── GET / — list workspace roles ────────────────────────────────────────
roles.get('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const rows = await sql`
    select id, name, is_admin
    from roles
    where workspace_id = ${workspaceId}
    order by name asc
  `;
  return c.json({ roles: rows });
});

// ─── POST / — create role ────────────────────────────────────────────────
roles.post('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = RoleBody.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  try {
    const [role] = await sql`
      insert into roles (workspace_id, name, is_admin)
      values (${workspaceId}, ${input.name}, ${input.is_admin ?? false})
      returning id, name, is_admin
    `;
    return c.json({ role }, 201);
  } catch (err) {
    if ((err as any)?.code === '23505') return c.json({ error: 'Role name already exists' }, 409);
    throw err;
  }
});

// ─── PATCH /:id — rename or change is_admin ──────────────────────────────
const PatchRole = z.object({
  name:     z.string().min(1).max(100).optional(),
  is_admin: z.boolean().optional(),
}).strict();

roles.patch('/:id', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PatchRole.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: 'No fields to update' }, 400);

  // Build an explicit column whitelist rather than spreading parsed.data into
  // sql(): .strict() above already rejects unknown keys, but this keeps the
  // set of writable columns visible and pinned at the call site.
  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined)     updates.name     = parsed.data.name;
  if (parsed.data.is_admin !== undefined) updates.is_admin = parsed.data.is_admin;

  try {
    const [role] = await sql`
      update roles set ${sql(updates)}
      where id = ${id} and workspace_id = ${workspaceId}
      returning id, name, is_admin
    `;
    if (!role) return c.json({ error: 'Role not found' }, 404);
    return c.json({ role });
  } catch (err) {
    if ((err as any)?.code === '23505') return c.json({ error: 'Role name already exists' }, 409);
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
