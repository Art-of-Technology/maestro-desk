import { Hono } from 'hono';
import { z } from 'zod';
import { bodyLimit } from 'hono/body-limit';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspaceAdmin } from '../lib/authz.js';
import { getDb } from '../lib/db.js';
import { effectivePermissions, permissionGroups, permissionKeys } from '../lib/role-permissions.js';

// Migration to Neon — Step 3. Listing roles is member-level (the original
// roles read RLS was `using (workspace_id = current_workspace_id())` — any
// workspace member), but CREATE/UPDATE/DELETE are ADMIN-only: a role carries
// `is_admin`, so letting a non-admin write roles is a privilege-escalation
// path (a member could flip their own role's is_admin). Mutations gate on
// requireWorkspaceAdmin, matching routes/agents.ts. Workspace-scoped via getDb().
export const roles = new Hono();

roles.use('*', requireAuth);

const PermissionSet = z.record(z.string(), z.boolean()).superRefine((value, ctx) => {
  if (Object.keys(value).length !== permissionKeys.length || permissionKeys.some(key => !Object.hasOwn(value, key)))
    ctx.addIssue({ code: 'custom', message: 'Save a complete set of supported permissions.' });
});
const MatrixSave = z.object({
  roles: z.array(z.object({ id: z.string().uuid(), version: z.number().int().nonnegative(), permissions: PermissionSet }).strict()).max(200),
  new_roles: z.array(z.object({ name: z.string().trim().min(1).max(100), permissions: PermissionSet }).strict()).max(1),
}).strict();

roles.put('/permissions', bodyLimit({ maxSize: 256 * 1024 }), async c => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;
  const parsed = MatrixSave.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Choose valid roles and permissions.', issues: parsed.error.issues }, 400);
  const { roles: edits, new_roles: additions } = parsed.data;
  if (new Set(edits.map(row => row.id)).size !== edits.length) return c.json({ error: 'Choose each role once.' }, 400);
  const sql = getDb(), ws = c.get('workspaceId');
  try {
    const result = await sql.begin(async tx => {
      const rows = edits.length ? await tx`select id, is_admin, permissions_version, permissions, can_delete, can_manage_custom_fields from roles
        where workspace_id=${ws} and id in ${tx(edits.map(row => row.id))} order by id for update` : [];
      if (rows.length !== edits.length) return { conflict: 'A role is no longer available. Reload the permissions page.' };
      if (rows.some(row => row.is_admin)) return { conflict: 'Brand Admin permissions are protected.' };
      if (rows.some(row => row.permissions_version !== edits.find(edit => edit.id === row.id)!.version))
        return { conflict: 'Permissions changed since you opened this page. Reload before saving.' };
      for (const edit of edits) await tx`update roles set permissions=${tx.json(edit.permissions)},
        permissions_version=permissions_version+1,
        can_manage_custom_fields=${edit.permissions['tools.custom_fields']},
        can_delete=${edit.permissions['tickets.delete'] && edit.permissions['customers.delete'] && edit.permissions['customers.merge']}
        where workspace_id=${ws} and id=${edit.id}`;
      const created: string[] = [];
      for (const addition of additions) {
        const [role] = await tx`insert into roles(workspace_id,name,permissions,can_manage_custom_fields,can_delete)
          values(${ws},${addition.name},${tx.json(addition.permissions)},${addition.permissions['tools.custom_fields']},
            ${addition.permissions['tickets.delete'] && addition.permissions['customers.delete'] && addition.permissions['customers.merge']}) returning id`;
        created.push(role.id);
      }
      const changes = edits.map(edit => {
        const before = effectivePermissions(rows.find(row => row.id === edit.id)!);
        return { role_id: edit.id, granted: permissionKeys.filter(key => !before[key] && edit.permissions[key]),
          revoked: permissionKeys.filter(key => before[key] && !edit.permissions[key]) };
      });
      changes.push(...additions.map((addition, index) => ({ role_id: created[index],
        granted: permissionKeys.filter(key => addition.permissions[key]), revoked: [] })));
      if (edits.length || additions.length) await tx`insert into audit_events(workspace_id,actor_user_id,action,target_type,metadata)
        values(${ws},${c.get('userId')},'role.permissions_saved','role',${tx.json({ changes, created })})`;
      return { roles: await tx`select id,name,is_admin,can_manage_custom_fields,can_delete,permissions,permissions_version
        from roles where workspace_id=${ws} order by name` };
    });
    if ('conflict' in result) return c.json({ error: result.conflict }, 409);
    return c.json({ roles: result.roles.map(row => ({ ...row, permissions: effectivePermissions(row) })), permission_groups: permissionGroups });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return c.json({ error: 'A role with that name already exists. Choose another name.' }, 409);
    throw err;
  }
});

const RoleBody = z.object({
  name:                     z.string().trim().min(1).max(100),
  is_admin:                 z.boolean().optional(),
  can_manage_custom_fields: z.boolean().optional(),
  can_delete:               z.boolean().optional(),
}).strict();

// ─── GET / — list workspace roles ────────────────────────────────────────
roles.get('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const rows = await sql`
    select id, name, is_admin, can_manage_custom_fields, can_delete, permissions, permissions_version
    from roles
    where workspace_id = ${workspaceId}
    order by name asc
  `;
  return c.json({ roles: rows.map(row => ({ ...row, permissions: effectivePermissions(row) })), permission_groups: permissionGroups });
});

// ─── POST / — create role ────────────────────────────────────────────────
roles.post('/', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = RoleBody.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  // Normalisation invariant: admin roles never carry materialised capability
  // flags — the grant is implicit (every read path ORs is_admin), and a
  // materialised true would silently survive a later is_admin demotion.
  const isAdmin = input.is_admin ?? false;
  try {
    const [role] = await sql`
      insert into roles (workspace_id, name, is_admin, can_manage_custom_fields, can_delete, permissions)
      values (${workspaceId}, ${input.name}, ${isAdmin},
              ${isAdmin ? false : (input.can_manage_custom_fields ?? false)},
              ${isAdmin ? false : (input.can_delete ?? false)}, ${sql.json(isAdmin ? {} : {
                'tools.custom_fields': input.can_manage_custom_fields === true,
                'tickets.delete': input.can_delete === true, 'customers.delete': input.can_delete === true, 'customers.merge': input.can_delete === true,
              })})
      returning id, name, is_admin, can_manage_custom_fields, can_delete
    `;
    return c.json({ role }, 201);
  } catch (err) {
    if ((err as any)?.code === '23505') return c.json({ error: 'Role name already exists' }, 409);
    throw err;
  }
});

// ─── PATCH /:id — rename, change is_admin, or toggle custom-field mgmt ────
const PatchRole = z.object({
  name:                     z.string().min(1).max(100).optional(),
  is_admin:                 z.boolean().optional(),
  can_manage_custom_fields: z.boolean().optional(),
  can_delete:               z.boolean().optional(),
}).strict();

roles.patch('/:id', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

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
  if (parsed.data.name !== undefined)                     updates.name                     = parsed.data.name;
  if (parsed.data.is_admin !== undefined)                 updates.is_admin                 = parsed.data.is_admin;
  if (parsed.data.can_manage_custom_fields !== undefined) updates.can_manage_custom_fields = parsed.data.can_manage_custom_fields;
  if (parsed.data.can_delete !== undefined)               updates.can_delete               = parsed.data.can_delete;

  try {
    // Same normalisation invariant as POST: if the row ends up (or already
    // is) admin, clear any materialised capability flags — whether this PATCH
    // set is_admin=true on a flagged role, or tried to flag an admin role.
    // Without this, demoting the role later would retain the stale grant.
    // One transaction so a crash between the two UPDATEs can't leave an
    // admin row carrying materialised flags.
    const role = await sql.begin(async (tx) => {
      const [existing] = await tx`select is_admin from roles where id=${id} and workspace_id=${workspaceId} for update`;
      if (existing?.is_admin && (parsed.data.name !== undefined || parsed.data.is_admin === false)) return 'protected';
      let [row] = await tx`
        update roles set ${tx(updates)}
        where id = ${id} and workspace_id = ${workspaceId}
        returning id, name, is_admin, can_manage_custom_fields, can_delete
      `;
      if (row) await tx`update roles set permissions_version=permissions_version+1,
        permissions=case when permissions is null then null else permissions || ${tx.json({
          ...(parsed.data.can_manage_custom_fields !== undefined ? { 'tools.custom_fields': parsed.data.can_manage_custom_fields } : {}),
          ...(parsed.data.can_delete !== undefined ? { 'tickets.delete': parsed.data.can_delete, 'customers.delete': parsed.data.can_delete, 'customers.merge': parsed.data.can_delete } : {}),
        })} end where id=${id} and workspace_id=${workspaceId}`;
      if (row && row.is_admin) {
        [row] = await tx`
          update roles set can_manage_custom_fields = false, can_delete = false, permissions='{}'::jsonb
          where id = ${id} and workspace_id = ${workspaceId}
          returning id, name, is_admin, can_manage_custom_fields, can_delete
        `;
      }
      return row ?? null;
    });
    if (role === 'protected') return c.json({ error: 'Brand Admin roles are protected.' }, 409);
    if (!role) return c.json({ error: 'Role not found' }, 404);
    return c.json({ role });
  } catch (err) {
    if ((err as any)?.code === '23505') return c.json({ error: 'Role name already exists' }, 409);
    throw err;
  }
});

// ─── DELETE /:id — refuse if any workspace_members reference it ──────────
roles.delete('/:id', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const [role] = await sql`select is_admin from roles where id=${id} and workspace_id=${workspaceId}`;
  if (role?.is_admin) return c.json({ error: 'Brand Admin roles are protected.' }, 409);

  const [{ count }] = await sql`
    select count(*)::int from workspace_members where workspace_id = ${workspaceId} and role_id = ${id}
  `;
  if (count > 0) {
    return c.json({ error: `${count} member(s) still assigned to this role` }, 409);
  }

  await sql`delete from roles where id = ${id} and workspace_id = ${workspaceId}`;
  return new Response(null, { status: 204 });
});
