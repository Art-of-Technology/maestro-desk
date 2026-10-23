import type { Context } from 'hono';
import { getDb } from './db.js';
import { allowed, requirePermission } from './role-permissions.js';

// Per-route authorization helpers (migration to Neon — Step 3).
//
// These replace the Supabase RLS policies. The auth middleware already
// verifies the caller is a member of the active workspace (or a platform
// admin) and stamps `userId` + `workspaceId` on the context; these helpers
// add the finer-grained checks that specific RLS policies used to enforce.
//
// All reads hit Neon directly. A route uses them like:
//   const denied = await requireWorkspaceAdmin(c);
//   if (denied) return denied;   // 403 response, already shaped
//
// Returning the Response (rather than throwing) keeps the call sites explicit
// and matches the existing route style.

// Allows the request only if the caller is an admin in the active workspace,
// OR a platform admin (the cross-workspace escape hatch the RLS policies
// carried as `or is_platform_admin`). Replaces the `is_workspace_admin` RPC +
// the admin-write RLS policies (e.g. ticket_categories_admin_write,
// workspace_members_admin_update).
export async function requireWorkspaceAdmin(c: Context): Promise<Response | null> {
  const sql = getDb();
  const userId = c.get('userId');
  const workspaceId = c.get('workspaceId');

  const [row] = await sql<{ ws_admin: boolean; platform_admin: boolean }[]>`
    select
      coalesce((
        select bool_or(r.is_admin)
        from workspace_members wm
        join roles r on r.id = wm.role_id
        where wm.user_id = ${userId}
          and wm.workspace_id = ${workspaceId}
          and wm.active = true
      ), false) as ws_admin,
      coalesce((
        select u.is_platform_admin from users u where u.id = ${userId}
      ), false) as platform_admin
  `;

  if (row?.ws_admin || row?.platform_admin) return null;
  return c.json({ error: 'Admin permission required' }, 403);
}

// Allows the request only if the caller may manage custom-field DEFINITIONS
// (create / edit / delete fields) in the active workspace: a workspace admin,
// a platform admin, OR a member whose role carries can_manage_custom_fields
// ("Senior Agent and above"). Filling in / editing field VALUES is open to any
// member and is NOT gated by this helper.
export async function requireCustomFieldManager(c: Context): Promise<Response | null> {
  return requirePermission(c, 'tools.custom_fields');
}

// Ticket deletion has its own grant; profile deletion and merging use their own checks.
export async function hasDeletePermission(c: Context): Promise<boolean> {
  return allowed(c, 'tickets.delete');
}

// Response-shaped wrapper over hasDeletePermission, matching the style of
// the other require* helpers for routes with no exception path.
export async function requireDeletePermission(c: Context): Promise<Response | null> {
  if (await hasDeletePermission(c)) return null;
  return c.json({ error: 'You do not have permission to delete records' }, 403);
}
