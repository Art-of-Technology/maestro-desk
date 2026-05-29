import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin, userClient } from '../lib/supabase.ts';

declare module 'hono' {
  interface ContextVariableMap {
    userId: string;
    workspaceId: string;
    sb:     SupabaseClient;
    sbUser: SupabaseClient;
  }
}

// Verifies the caller's Supabase JWT, resolves the active workspace from the
// X-Workspace-Id header (must be one they're a member of), and attaches BOTH
// Supabase clients to the request context:
//
//   c.get('sb')     — service-role; bypasses RLS. Used by every route today.
//   c.get('sbUser') — user-scoped; carries the caller's JWT, RLS-enforced.
//                     Routes opt in by switching their queries to this client.
//
// The pivot from `sb` to `sbUser` happens table-family by table-family. The
// 20260529120000_tickets_rls_pivot migration moves the ticket family's
// policies to is_workspace_member(); a follow-up PR will flip tickets.ts
// to use sbUser. Other table families stay on the legacy policies + sb
// until they're individually pivoted.
//
// PREREQUISITE for any route using sbUser: the Custom Access Token Hook
// must be enabled (see 20260529110000_custom_access_token_hook.sql). The
// hook injects workspace_ids into the JWT; without it, RLS denies
// everything on the pivoted tables.
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

  // Platform admins can access any workspace by design — same shape as the
  // OR is_platform_admin() clauses in workspace-scoped RLS policies. We
  // check this in parallel with the membership lookup so the happy path
  // for normal agents isn't slowed down.
  const [memRes, userRes] = await Promise.all([
    supabaseAdmin
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId)
      .eq('active', true)
      .maybeSingle(),
    supabaseAdmin
      .from('users')
      .select('is_platform_admin')
      .eq('id', userId)
      .maybeSingle(),
  ]);
  if (memRes.error)  throw new HTTPException(500, { message: memRes.error.message });
  if (userRes.error) throw new HTTPException(500, { message: userRes.error.message });
  if (!memRes.data && !userRes.data?.is_platform_admin) {
    throw new HTTPException(403, { message: 'Not a member of that workspace' });
  }

  c.set('userId', userId);
  c.set('workspaceId', workspaceId);
  c.set('sb', supabaseAdmin);
  c.set('sbUser', userClient(jwt));
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
  c.set('sbUser', userClient(jwt));
  await next();
};
