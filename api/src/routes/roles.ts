import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';

export const roles = new Hono();

roles.use('*', requireAuth);

const RoleBody = z.object({
  name:        z.string().min(1).max(100),
  is_admin:    z.boolean().optional(),
  permissions: z.array(z.string().min(1).max(64)).optional(),
});

// ─── GET / — list workspace roles with their granted permission keys ─────
roles.get('/', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');

  const { data, error } = await sb
    .from('roles')
    .select(`
      id, name, is_admin,
      role_permissions(permission_key)
    `)
    .eq('workspace_id', workspaceId)
    .order('name', { ascending: true });
  if (error) return c.json({ error: error.message }, 500);

  const out = (data || []).map((r: any) => ({
    id:          r.id,
    name:        r.name,
    is_admin:    r.is_admin,
    permissions: (r.role_permissions || []).map((rp: any) => rp.permission_key),
  }));
  return c.json({ roles: out });
});

// ─── POST / — create role with optional permissions[] ────────────────────
roles.post('/', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = RoleBody.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  const { data: role, error: roleErr } = await sb
    .from('roles')
    .insert({
      workspace_id: workspaceId,
      name:         input.name,
      is_admin:     input.is_admin ?? false,
    })
    .select('id, name, is_admin')
    .single();
  if (roleErr) {
    if (roleErr.code === '23505') return c.json({ error: 'Role name already exists' }, 409);
    return c.json({ error: roleErr.message }, 500);
  }

  // Grant requested permissions. The permissions table is global so we
  // trust the keys to be valid (the FK enforces it — bad keys produce
  // a 23503 the client surfaces).
  if (input.permissions && input.permissions.length > 0) {
    const rows = input.permissions.map((key) => ({ role_id: role.id, permission_key: key }));
    const { error: rpErr } = await sb.from('role_permissions').insert(rows);
    if (rpErr) return c.json({ error: rpErr.message, role }, 500);
  }

  return c.json({ role: { ...role, permissions: input.permissions ?? [] } }, 201);
});

// ─── PATCH /:id — rename, change is_admin, or replace permission set ─────
//
// permissions[] (when present) is a REPLACE — the server deletes any
// existing role_permissions for this role and inserts the new set.
const PatchRole = z.object({
  name:        z.string().min(1).max(100).optional(),
  is_admin:    z.boolean().optional(),
  permissions: z.array(z.string().min(1).max(64)).optional(),
}).strict();

roles.patch('/:id', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PatchRole.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  // Confirm workspace scope before touching anything.
  const { data: existing, error: lookupErr } = await sb
    .from('roles')
    .select('id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (lookupErr) return c.json({ error: lookupErr.message }, 500);
  if (!existing)  return c.json({ error: 'Role not found' }, 404);

  // Update the role's own columns if any.
  const roleUpdates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined)     roleUpdates.name     = parsed.data.name;
  if (parsed.data.is_admin !== undefined) roleUpdates.is_admin = parsed.data.is_admin;
  if (Object.keys(roleUpdates).length > 0) {
    const { error: upErr } = await sb
      .from('roles')
      .update(roleUpdates)
      .eq('id', id)
      .eq('workspace_id', workspaceId);
    if (upErr) {
      if (upErr.code === '23505') return c.json({ error: 'Role name already exists' }, 409);
      return c.json({ error: upErr.message }, 500);
    }
  }

  // Replace permissions set if provided.
  if (parsed.data.permissions !== undefined) {
    const { error: delErr } = await sb
      .from('role_permissions')
      .delete()
      .eq('role_id', id);
    if (delErr) return c.json({ error: delErr.message }, 500);
    if (parsed.data.permissions.length > 0) {
      const rows = parsed.data.permissions.map((key) => ({ role_id: id, permission_key: key }));
      const { error: insErr } = await sb.from('role_permissions').insert(rows);
      if (insErr) return c.json({ error: insErr.message }, 500);
    }
  }

  // Re-fetch to return the canonical post-state.
  const { data: refetched, error: refetchErr } = await sb
    .from('roles')
    .select(`id, name, is_admin, role_permissions(permission_key)`)
    .eq('id', id)
    .single();
  if (refetchErr) return c.json({ error: refetchErr.message }, 500);

  return c.json({
    role: {
      id:          refetched.id,
      name:        refetched.name,
      is_admin:    refetched.is_admin,
      permissions: ((refetched as any).role_permissions || []).map((rp: any) => rp.permission_key),
    },
  });
});

// ─── DELETE /:id — refuse if any active workspace_members reference it ──
roles.delete('/:id', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const { count, error: cntErr } = await sb
    .from('workspace_members')
    .select('user_id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('role_id', id);
  if (cntErr) return c.json({ error: cntErr.message }, 500);
  if ((count ?? 0) > 0) {
    return c.json({ error: `${count} member(s) still assigned to this role` }, 409);
  }

  const { error } = await sb
    .from('roles')
    .delete()
    .eq('id', id)
    .eq('workspace_id', workspaceId);
  if (error) return c.json({ error: error.message }, 500);
  return new Response(null, { status: 204 });
});
