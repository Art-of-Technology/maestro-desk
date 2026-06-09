import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { supabaseAdmin } from '../lib/supabase.ts';
import { getDb } from '../lib/db.ts';

// Gates the /api/v1/god/* routes. Verifies the caller's Supabase JWT, looks
// up their public.users row, and refuses the request unless
// is_platform_admin = true.
//
// Unlike requireAuth this middleware does NOT consume X-Workspace-Id — god
// routes are inherently cross-workspace and operate on `:id` path params
// when they need to target a specific brand.
//
// 401 on missing/invalid token, 403 on authenticated-but-not-god. The 403
// message is deliberately terse — we don't want to leak the existence of
// the flag to non-gods. The audit row (see writeAudit() below) captures
// failed attempts for review.
//
// Audit responsibility: god routes that mutate state MUST emit an
// audit_events row themselves (the middleware can't see the action shape).
// Use the writeAudit helper below to keep the row shape consistent.

export const requirePlatformAdmin: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Missing bearer token' });
  }
  const jwt = authHeader.slice('Bearer '.length);

  const { data, error } = await supabaseAdmin.auth.getUser(jwt);
  if (error || !data.user) {
    throw new HTTPException(401, { message: 'Invalid token' });
  }
  const userId = data.user.id;

  const { data: userRow, error: uErr } = await supabaseAdmin
    .from('users')
    .select('is_platform_admin')
    .eq('id', userId)
    .maybeSingle();
  if (uErr) throw new HTTPException(500, { message: uErr.message });
  if (!userRow?.is_platform_admin) {
    throw new HTTPException(403, { message: 'Forbidden' });
  }

  c.set('userId', userId);
  c.set('sb', supabaseAdmin);
  await next();
};

// Audit helper for god-route mutations. Writes to audit_events (Neon) with the
// (actor_user_id, workspace_id, action, target_*, metadata) shape established
// in 20260520120600_activity_audit.sql. Errors are swallowed (logged) so an
// audit failure doesn't 500 the underlying request — the action already
// succeeded by the time we get here, and a missing audit row is recoverable
// at the SIEM layer; a 500 to the operator is not.
export async function writeAudit(args: {
  workspaceId: string;
  actorUserId: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    const sql = getDb();
    await sql`
      insert into audit_events (workspace_id, actor_user_id, action, target_type, target_id, metadata)
      values (
        ${args.workspaceId}, ${args.actorUserId}, ${args.action},
        ${args.targetType ?? null}, ${args.targetId ?? null},
        ${args.metadata ? sql.json(args.metadata as any) : null}
      )
    `;
  } catch (err) {
    console.error('audit_events insert failed:', { args, error: err instanceof Error ? err.message : err });
  }
}
