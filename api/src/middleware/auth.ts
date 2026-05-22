import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../lib/supabase.ts';

declare module 'hono' {
  interface ContextVariableMap {
    userId: string;
    workspaceId: string;
    sb: SupabaseClient;
  }
}

// Verifies the caller's Supabase JWT, resolves the active workspace from the
// X-Workspace-Id header (must be one they're a member of), and attaches the
// service-role Supabase client + extracted (userId, workspaceId) to the
// request context.
//
// Why service role and not the user's JWT?
// RLS in 20260520121400_rls_policies.sql reads workspace_id from
// `request.jwt.claims->>'workspace_id'` via public.current_workspace_id().
// Supabase doesn't put workspace_id in the JWT by default — it lands there
// only once we configure a Custom Access Token Hook (or migrate the helper
// to a membership-join check). Until that's wired up, using the user's JWT
// would have RLS deny every read.
//
// For now: service role bypasses RLS; routes MUST explicitly scope queries
// by workspaceId from this context (the request will already have verified
// membership). RLS stays enabled in the DB as defense-in-depth for any
// direct browser → PostgREST traffic that bypasses the API.
export const requireAuth: MiddlewareHandler = async (c, next) => {
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

  const workspaceId = c.req.header('X-Workspace-Id');
  if (!workspaceId) {
    throw new HTTPException(400, { message: 'X-Workspace-Id header required' });
  }

  const { data: membership, error: mErr } = await supabaseAdmin
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .eq('active', true)
    .maybeSingle();
  if (mErr) throw new HTTPException(500, { message: mErr.message });
  if (!membership) {
    throw new HTTPException(403, { message: 'Not a member of that workspace' });
  }

  c.set('userId', userId);
  c.set('workspaceId', workspaceId);
  c.set('sb', supabaseAdmin);
  await next();
};

// Like requireAuth but without the workspace requirement — verifies the JWT
// and attaches userId + sb to context, nothing more. Used for endpoints
// that operate on the caller's identity rather than a specific workspace
// (e.g. GET /whoami, the platform-admin boot-up call in the SPA).
export const requireAuthOnly: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Missing bearer token' });
  }
  const jwt = authHeader.slice('Bearer '.length);

  const { data, error } = await supabaseAdmin.auth.getUser(jwt);
  if (error || !data.user) {
    throw new HTTPException(401, { message: 'Invalid token' });
  }

  c.set('userId', data.user.id);
  c.set('sb', supabaseAdmin);
  await next();
};
