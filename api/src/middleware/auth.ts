import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { auth } from '../lib/auth.ts';
import { getDb } from '../lib/db.ts';

declare module 'hono' {
  interface ContextVariableMap {
    userId: string;
    workspaceId: string;
  }
}

// Verifies the caller's Better Auth session (bearer token), resolves the
// active workspace from the X-Workspace-Id header (must be one they're an
// active member of, unless they're a platform admin), and attaches userId +
// workspaceId to the request context. Membership + platform-admin are read
// from Neon — the per-route authorization that replaced Supabase RLS.
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    throw new HTTPException(401, { message: 'Invalid or missing session' });
  }
  const userId = session.user.id;

  const workspaceId = c.req.header('X-Workspace-Id');
  if (!workspaceId) {
    throw new HTTPException(400, { message: 'X-Workspace-Id header required' });
  }

  // Platform admins can access any workspace by design (the hatch the old
  // is_platform_admin() RLS clauses provided). Check it in parallel with the
  // membership lookup so the happy path for normal agents isn't slowed down.
  const sql = getDb();
  const [member, [user]] = await Promise.all([
    sql`select 1 from workspace_members where user_id = ${userId} and workspace_id = ${workspaceId} and active = true`,
    sql<{ is_platform_admin: boolean | null }[]>`select is_platform_admin from users where id = ${userId}`,
  ]);
  if (member.length === 0 && !user?.is_platform_admin) {
    throw new HTTPException(403, { message: 'Not a member of that workspace' });
  }

  c.set('userId', userId);
  c.set('workspaceId', workspaceId);
  await next();
};

// Like requireAuth but without the workspace requirement — verifies the
// session and attaches userId only. Used for endpoints that operate on the
// caller's identity rather than a specific workspace (e.g. GET /whoami, the
// platform-admin boot-up call in the SPA).
export const requireAuthOnly: MiddlewareHandler = async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    throw new HTTPException(401, { message: 'Invalid or missing session' });
  }
  c.set('userId', session.user.id);
  await next();
};
