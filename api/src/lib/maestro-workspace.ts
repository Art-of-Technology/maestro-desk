// Brand → workspace projection (Maestro brands are the canonical workspace).
//
// Given a Maestro brand the signed-in agent can access, return the Desk
// workspace that represents it — provisioning one on first sight — and make
// sure the agent has an active membership with the role their Maestro access
// implies. The rest of the app keeps using the internal workspace_id; this is
// the one place that knows a workspace IS a Maestro brand.

import { getDb } from './db.js';
import type { MaestroBrand } from './maestro.js';

export interface BrandWorkspace {
  workspace_id: string;
  workspace_name: string;
  workspace_slug: string;
  workspace_logo_url: string | null;
  workspace_primary_color: string | null;
  role_name: string | null;
  is_admin: boolean;
  active: boolean;
  suspended: boolean;
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'brand'
  );
}

interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  primary_color: string | null;
  suspended_at: string | null;
}

/**
 * Resolve (find-or-provision) the workspace for a brand and ensure the agent is
 * an active member. `roleName` is the Desk role their Maestro role maps to
 * (see mapMaestroBrandRole) — applied only when the membership is first
 * created, so later manual role changes by an admin aren't clobbered on every
 * sign-in.
 */
export async function resolveBrandWorkspace(
  userId: string,
  brand: MaestroBrand,
  roleName: string,
): Promise<BrandWorkspace> {
  const sql = getDb();

  let ws = await findByBrand(brand.id);
  if (!ws) ws = await provisionForBrand(brand);

  // Ensure membership. A brand-new member is created active; an EXISTING member
  // is left untouched (`do nothing`) — role AND active are preserved. This is
  // deliberate: an admin who DEACTIVATES an agent (workspace_members.active =
  // false, via PATCH /agents/:userId) must have that stick, so a later Maestro
  // re-login can't silently resurrect access. No system path sets active = false,
  // so nothing legitimately needs re-login to auto-reactivate; reactivation is an
  // explicit admin action (the invite/add upsert in routes/agents.ts). Role
  // likewise stays as the operator set it since first sign-in.
  //
  // NOTE: this only makes the `active` flag durable. A hard DELETE of the
  // membership (DELETE /agents/:userId) leaves no row, so an agent who still
  // holds the brand upstream is re-provisioned active on next sign-in — Maestro
  // brand access is the source of truth for membership *existence*; `active` is
  // the durable local override. Deactivate, don't delete, to block persistently.
  const roleId = await roleIdForName(ws.id, roleName);
  await sql`
    insert into workspace_members (workspace_id, user_id, role_id, active)
    values (${ws.id}, ${userId}, ${roleId}, true)
    on conflict (workspace_id, user_id) do nothing
  `;

  // Read back the member's effective role + active flag (their existing values if
  // they predated this sign-in, else the ones we just inserted).
  const [member] = await sql<{ role_name: string | null; is_admin: boolean | null; active: boolean }[]>`
    select r.name as role_name, r.is_admin, wm.active
    from workspace_members wm
    left join roles r on r.id = wm.role_id
    where wm.workspace_id = ${ws.id} and wm.user_id = ${userId}
  `;

  return {
    workspace_id: ws.id,
    workspace_name: ws.name,
    workspace_slug: ws.slug,
    workspace_logo_url: ws.logo_url,
    workspace_primary_color: ws.primary_color,
    role_name: member?.role_name ?? null,
    is_admin: Boolean(member?.is_admin),
    active: Boolean(member?.active),
    suspended: Boolean(ws.suspended_at),
  };
}

/**
 * Authorization gate for brand-scoped player lookups. The lookup endpoints call
 * the gateway with the APP token, which can read every brand the app is
 * installed on — so we must enforce per-agent brand access HERE rather than
 * leaning on the platform to scope it per-user.
 *
 * Returns the id of the Desk workspace that projects this Maestro brand IF the
 * agent is an active member of it, else null. Callers use both the null-check
 * (does the agent have brand access?) and the id (to confirm the brand's
 * workspace matches the one being written to, and to write audit rows).
 */
export async function agentBrandWorkspaceId(userId: string, brandId: string): Promise<string | null> {
  const sql = getDb();
  const [row] = await sql<{ id: string }[]>`
    select w.id
    from workspaces w
    join workspace_members wm on wm.workspace_id = w.id
    where w.maestro_brand_id = ${brandId}
      and w.deleted_at is null
      and wm.user_id = ${userId}
      and wm.active = true
    limit 1
  `;
  return row?.id ?? null;
}

async function findByBrand(brandId: string): Promise<WorkspaceRow | null> {
  const sql = getDb();
  const [row] = await sql<WorkspaceRow[]>`
    select id, name, slug, logo_url, primary_color, suspended_at from workspaces
    where maestro_brand_id = ${brandId} and deleted_at is null
  `;
  return row ?? null;
}

async function provisionForBrand(brand: MaestroBrand): Promise<WorkspaceRow> {
  const sql = getDb();
  const name = brand.name || 'Brand';
  // Keep slugs unique-but-stable: brand slug if given, else a slug of the name,
  // suffixed with a brand-id fragment so two like-named brands don't collide.
  const baseSlug = brand.slug ? slugify(brand.slug) : slugify(name);
  const slug = `${baseSlug}-${brand.id.slice(0, 8)}`.slice(0, 60);

  try {
    // provision_brand() (20260522160000) bootstraps the whole tenant; tagging it
    // with maestro_brand_id must happen in the SAME transaction so a crash can't
    // leave an orphan workspace that's never findable by brand. If a concurrent
    // first sign-in already claimed this brand, the maestro_brand_id UPDATE hits
    // the unique constraint, the whole transaction rolls back, and the
    // half-built workspace never persists — no manual cleanup needed.
    const [row] = await sql.begin(async (tx) => {
      const [{ id }] = await tx<{ id: string }[]>`
        select provision_brand(
          ${name}, ${slug}, ${null}, ${brand.logoUrl ?? null}, ${null}
        ) as id
      `;
      await tx`update workspaces set maestro_brand_id = ${brand.id} where id = ${id}`;
      return tx<WorkspaceRow[]>`
        select id, name, slug, logo_url, primary_color, suspended_at
        from workspaces where id = ${id}
      `;
    });
    return row;
  } catch (err) {
    // 23505 = a concurrent first sign-in won the race; the transaction rolled
    // back, so just use the winner it provisioned.
    if ((err as { code?: string })?.code === '23505') {
      const winner = await findByBrand(brand.id);
      if (winner) return winner;
    }
    throw err;
  }
}

async function roleIdForName(workspaceId: string, roleName: string): Promise<string> {
  const sql = getDb();
  // Prefer the mapped role; fall back to the lowest-privilege non-admin role so
  // a surprising role name never silently grants admin.
  const [row] = await sql<{ id: string }[]>`
    select id from roles
    where workspace_id = ${workspaceId}
    order by (name = ${roleName}) desc, is_admin asc, name asc
    limit 1
  `;
  if (!row) throw new Error(`No roles found for workspace ${workspaceId} — provisioning corrupted`);
  return row.id;
}
