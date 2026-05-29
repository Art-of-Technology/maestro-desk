import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireAuthOnly } from '../middleware/auth.ts';
import { supabaseAdmin } from '../lib/supabase.ts';

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
  const userId = c.get('userId');

  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select('id, email, name, initials, is_platform_admin')
    .eq('id', userId)
    .single();
  if (error) return c.json({ error: error.message }, 500);

  // Active memberships in non-deleted, non-system workspaces. The system
  // unrouted-bucket workspace exists for routing fallback only — no human
  // ever signs into it.
  const { data: memberships, error: mErr } = await supabaseAdmin
    .from('workspace_members')
    .select(`
      role_id,
      active,
      workspaces!inner(id, name, slug, suspended_at, is_unrouted_bucket, deleted_at),
      roles(name, is_admin)
    `)
    .eq('user_id', userId)
    .eq('active', true);
  if (mErr) return c.json({ error: mErr.message }, 500);

  const shaped = (memberships || [])
    .filter((m: any) => m.workspaces && !m.workspaces.deleted_at && !m.workspaces.is_unrouted_bucket)
    .map((m: any) => ({
      workspace_id:   m.workspaces.id,
      workspace_name: m.workspaces.name,
      workspace_slug: m.workspaces.slug,
      suspended:      Boolean(m.workspaces.suspended_at),
      role_id:        m.role_id,
      role_name:      m.roles?.name || null,
      is_admin:       Boolean(m.roles?.is_admin),
    }));

  return c.json({ user, memberships: shaped });
});

// GET /whoami/claims — surface the custom claims actually present in
// the caller's JWT, so we can verify the Custom Access Token Hook is
// active end-to-end. The middleware has already verified the bearer
// token upstream, so we just decode the payload here without
// re-validating. Returns only the workspace-related claims (not the
// full Supabase payload) — keeps the response shape stable as the
// hook evolves.
whoami.get('/claims', (c) => {
  const auth = c.req.header('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new HTTPException(400, { message: 'Malformed token' });
  }
  let payload: any;
  try {
    // base64url-decode the payload. Bun's Buffer handles standard
    // base64; convert url-safe chars and pad before decoding.
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    payload = JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf-8'));
  } catch {
    throw new HTTPException(400, { message: 'Could not decode token payload' });
  }
  return c.json({
    workspace_ids:     payload.workspace_ids     ?? null,
    is_platform_admin: payload.is_platform_admin ?? null,
    // Echo a small slice of standard claims so the caller can sanity-
    // check which token they're holding.
    sub:               payload.sub,
    role:              payload.role,
    iss:               payload.iss,
    exp:               payload.exp,
    // hook_active is the load-bearing field for ops: true means our
    // custom claims are flowing, false means the hook isn't enabled
    // in the dashboard yet.
    hook_active:       payload.workspace_ids !== undefined,
  });
});
