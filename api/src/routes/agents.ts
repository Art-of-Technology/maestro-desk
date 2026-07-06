import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../lib/db.js';
import { requireWorkspaceAdmin } from '../lib/authz.js';
import { auth } from '../lib/auth.js';
import { writeAudit } from '../middleware/platform-admin.js';
import { deriveNameFromEmail, initialsFromName, randomPassword } from '../lib/invite.js';
import { revokeSessionsIfNoAccess } from '../lib/sessions.js';

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

// ─── POST /invite — invite an agent to THIS workspace (admin only) ──────────
// Scoped twin of the god owner-invite (routes/god.ts): same Better-Auth user
// minting + set-password email, but on the caller's own workspace and at a
// caller-chosen role (not hardcoded Admin). Idempotent — re-inviting an
// existing member updates their role, reactivates them, and re-sends the link.
const InviteAgent = z.object({
  email:   z.string().email(),
  name:    z.string().trim().min(1).max(120).optional(),
  role_id: z.string().uuid(),
}).strict();

agents.post('/invite', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const body = await c.req.json().catch(() => null);
  const parsed = InviteAgent.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  const email = parsed.data.email.toLowerCase();

  // The role must belong to THIS workspace (no cross-tenant FK).
  const [role] = await sql<{ id: string }[]>`
    select id from roles where id = ${parsed.data.role_id} and workspace_id = ${workspaceId}
  `;
  if (!role) return c.json({ error: 'Role not found in this workspace' }, 400);

  const derived = deriveNameFromEmail(email);
  const name = parsed.data.name?.trim() || derived.name;
  const initials = parsed.data.name ? initialsFromName(name) : derived.initials;

  // Ensure a Better Auth user exists for this email (signUpEmail creates the
  // users + credential rows; reuse the existing user otherwise).
  const [existing] = await sql<{ id: string }[]>`select id from users where email = ${email}`;
  let authUserId: string;
  if (existing) {
    authUserId = existing.id;
  } else {
    try {
      const created = await auth.api.signUpEmail({ body: { email, name, password: randomPassword() } });
      if (!created?.user?.id) return c.json({ error: 'Failed to create the invited user' }, 502);
      authUserId = created.user.id;
    } catch (err) {
      // Race: a concurrent invite may have created the row. Re-read and continue.
      const [raced] = await sql<{ id: string }[]>`select id from users where email = ${email}`;
      if (!raced) {
        console.error('[agents/invite] signUpEmail failed:', err instanceof Error ? err.message : err);
        return c.json({ error: 'Could not create the invited user' }, 502);
      }
      authUserId = raced.id;
    }
  }

  // Set initials only if not already present (don't clobber an existing user's
  // profile); signUpEmail sets name but not initials.
  await sql`
    insert into users (id, email, name, initials)
    values (${authUserId}, ${email}, ${name}, ${initials})
    on conflict (id) do update
      set email = excluded.email,
          initials = coalesce(nullif(users.initials, ''), excluded.initials)
  `;

  // Upsert membership at the chosen role (composite PK → idempotent).
  await sql`
    insert into workspace_members (workspace_id, user_id, role_id, active)
    values (${workspaceId}, ${authUserId}, ${role.id}, true)
    on conflict (workspace_id, user_id) do update
      set role_id = excluded.role_id, active = true
  `;

  // Email the set-password link (best-effort — membership already exists, so a
  // transient mail failure shouldn't 500; the admin can re-invite to re-send).
  let emailSent = true;
  try {
    await auth.api.requestPasswordReset({ body: { email } });
  } catch (err) {
    emailSent = false;
    console.error('[agents/invite] requestPasswordReset failed:', err instanceof Error ? err.message : err);
  }

  await writeAudit({
    workspaceId,
    actorUserId: c.get('userId'),
    action: 'agent.invited',
    targetType: 'user',
    targetId: authUserId,
    metadata: { email, role_id: role.id, email_sent: emailSent },
  });

  const [agent] = await AGENT_SELECT(sql, workspaceId, authUserId);
  return c.json({ user_id: authUserId, email, email_sent: emailSent, agent }, 201);
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

  // Deactivating a member may remove their last access — revoke their sessions
  // so identity-only endpoints (/whoami, /push) stop working too (#22).
  if (parsed.data.active === false) await revokeSessionsIfNoAccess(sql, targetUserId);

  const [agent] = await AGENT_SELECT(sql, workspaceId, targetUserId);
  return c.json({ agent });
});

// ─── POST /:userId/reset-password — re-send a set-password link (admin) ──────
// Admin-triggered counterpart to the self-serve "forgot password" flow: lets a
// workspace admin email an existing member a fresh Better-Auth set-password
// link (e.g. an invitee who never set one, or a locked-out agent). Scoped to
// THIS workspace — the target must be a member here, so there's no cross-tenant
// reset and no account-enumeration concern (the admin already knows the member
// exists). Best-effort send: a transient mail failure reports email_sent:false
// rather than 500ing, matching the /invite contract.
agents.post('/:userId/reset-password', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const targetUserId = c.req.param('userId');

  const [member] = await sql<{ email: string }[]>`
    select u.email
    from workspace_members wm
    join users u on u.id = wm.user_id and u.deleted_at is null
    where wm.workspace_id = ${workspaceId} and wm.user_id = ${targetUserId}
  `;
  if (!member) return c.json({ error: 'Membership not found' }, 404);

  let emailSent = true;
  try {
    await auth.api.requestPasswordReset({ body: { email: member.email } });
  } catch (err) {
    emailSent = false;
    console.error('[agents/reset-password] requestPasswordReset failed:', err instanceof Error ? err.message : err);
  }

  await writeAudit({
    workspaceId,
    actorUserId: c.get('userId'),
    action: 'agent.password_reset_sent',
    targetType: 'user',
    targetId: targetUserId,
    metadata: { email: member.email, email_sent: emailSent },
  });

  return c.json({ email_sent: emailSent });
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

  const [deleted] = await sql`
    delete from workspace_members
    where workspace_id = ${workspaceId} and user_id = ${targetUserId}
    returning user_id
  `;
  if (!deleted) return c.json({ error: 'Membership not found' }, 404);

  // Removing the membership may leave the user with no access — revoke their
  // sessions so their bearer token stops working everywhere (#22).
  await revokeSessionsIfNoAccess(sql, targetUserId);

  return new Response(null, { status: 204 });
});
