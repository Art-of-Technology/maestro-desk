import { Hono } from 'hono';
import { requireAuthOnly } from '../middleware/auth.js';
import { getDb } from '../lib/db.js';

// Identity + workspace memberships, read from Neon. Auth is verified by
// requireAuthOnly (Better Auth session). The old /claims diagnostic that
// decoded the Supabase JWT was removed at the auth cutover — Better Auth
// bearer tokens are opaque session ids, not JWTs with claims.
export const whoami = new Hono();

whoami.use('*', requireAuthOnly);

// Returns the caller's identity + workspace memberships — JWT-verified,
// no workspace context. The SPA hits this immediately after sign-in to:
//   (a) confirm the JWT works
//   (b) get the is_platform_admin flag to decide whether to show the god UI
//   (c) get the list of workspaces the user can sign into as an agent, so
//       the SPA can auto-pick (single membership) or render a picker
//
// /me is for workspace-scoped sessions (requires X-Workspace-Id +
// membership); /whoami is the workspace-agnostic equivalent for callers
// who haven't picked a workspace yet.
whoami.get('/', async (c) => {
  const sql = getDb();
  const userId = c.get('userId');

  const [user] = await sql<{ id: string; email: string; name: string | null; initials: string | null; is_platform_admin: boolean | null }[]>`
    select id, email, name, initials, is_platform_admin from users where id = ${userId}
  `;
  if (!user) return c.json({ error: 'User not found' }, 404);

  // Active memberships in non-deleted, non-system workspaces. The system
  // unrouted-bucket workspace exists for routing fallback only — no human
  // ever signs into it; the join filters it out alongside soft-deleted ones.
  const rows = await sql<{
    role_id: string | null; ws_id: string; ws_name: string; slug: string;
    logo_url: string | null; primary_color: string | null; suspended_at: string | null;
    maestro_brand_id: string | null;
    role_name: string | null; is_admin: boolean | null; can_manage_custom_fields: boolean | null;
    can_delete: boolean | null;
  }[]>`
    select wm.role_id, w.id as ws_id, w.name as ws_name, w.slug, w.logo_url, w.primary_color,
           w.suspended_at, w.maestro_brand_id, r.name as role_name, r.is_admin, r.can_manage_custom_fields,
           r.can_delete
    from workspace_members wm
    join workspaces w on w.id = wm.workspace_id
    left join roles r on r.id = wm.role_id
    where wm.user_id = ${userId} and wm.active = true
      and w.deleted_at is null and coalesce(w.is_unrouted_bucket, false) = false
  `;

  const shaped = rows.map((m) => ({
    workspace_id:            m.ws_id,
    workspace_name:          m.ws_name,
    workspace_slug:          m.slug,
    workspace_logo_url:      m.logo_url || null,
    workspace_primary_color: m.primary_color || null,
    suspended:               Boolean(m.suspended_at),
    // Maestro brand context (X-Brand-Id) for brand-scoped features like player
    // lookup. Null for non-Maestro workspaces (e.g. the internal desk). The
    // in-session workspace switcher stamps this exactly as the Maestro sign-in
    // and god "enter brand" flows do.
    maestro_brand_id:        m.maestro_brand_id || null,
    role_id:                 m.role_id,
    role_name:               m.role_name || null,
    is_admin:                Boolean(m.is_admin),
    // Admins implicitly manage custom fields; the flag covers non-admin
    // "senior" roles. The frontend gates the manage-fields UI on this.
    can_manage_custom_fields: Boolean(m.is_admin) || Boolean(m.can_manage_custom_fields),
    // Admins implicitly delete/merge; the flag grants it to non-admin roles.
    // The frontend gates delete surfaces and customer merge on this (wired
    // up by the delete/merge PRs that follow this plumbing in the stack).
    can_delete:               Boolean(m.is_admin) || Boolean(m.can_delete),
  }));

  return c.json({ user, memberships: shaped });
});
