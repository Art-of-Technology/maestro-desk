import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireAuthOnly } from '../middleware/auth.ts';
import { getDb } from '../lib/db.ts';

// Migration to Neon — Step 3. The identity reads (users + memberships) move to
// getDb(); JWT verification stays in requireAuthOnly until the auth flip. The
// /claims endpoint only decodes the bearer token (no DB) and is untouched.
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
    role_name: string | null; is_admin: boolean | null;
  }[]>`
    select wm.role_id, w.id as ws_id, w.name as ws_name, w.slug, w.logo_url, w.primary_color,
           w.suspended_at, r.name as role_name, r.is_admin
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
    role_id:                 m.role_id,
    role_name:               m.role_name || null,
    is_admin:                Boolean(m.is_admin),
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
