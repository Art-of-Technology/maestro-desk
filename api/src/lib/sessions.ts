import type { getDb } from './db.js';

// Session revocation on loss of access (advisory #22).
//
// requireAuth re-reads workspace_members.active + is_platform_admin on every
// request, so a disabled/removed agent is denied immediately on workspace and
// god routes, and a role change takes effect live. The residual is the
// identity-only requireAuthOnly endpoints (/whoami, /push/*), which keep
// working on the agent's existing Better Auth bearer token until it expires.
//
// When an agent loses ALL access — no active membership in any workspace AND
// not a platform admin — delete their Better Auth sessions so the token stops
// working everywhere. We scope it to "no access left" so a multi-workspace user
// removed from one workspace, or a platform admin, is NOT logged out.
//
// Deleting rows from the Better Auth `session` table is how revocation works
// against its own store (getSession then finds nothing → 401).
// Best-effort: this runs AFTER the authoritative membership change has already
// committed, and requireAuth re-checks access on the next request regardless, so
// a transient DB error here must never turn the caller's delete/deactivate into
// a 500. We log and move on.
export async function revokeSessionsIfNoAccess(sql: ReturnType<typeof getDb>, userId: string): Promise<void> {
  try {
    const [row] = await sql<{ has_active: boolean; platform_admin: boolean }[]>`
      select
        exists(select 1 from workspace_members where user_id = ${userId} and active = true) as has_active,
        coalesce((select is_platform_admin from users where id = ${userId}), false) as platform_admin
    `;
    if (row?.has_active || row?.platform_admin) return;
    await sql`delete from "session" where "userId" = ${userId}`;
  } catch (err) {
    console.warn('[sessions] revokeSessionsIfNoAccess failed:', err instanceof Error ? err.message : err);
  }
}
