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

  // Ensure membership. Role is set ONLY on first insert; an existing member
  // keeps whatever role they have (an operator may have promoted/demoted them).
  const roleId = await roleIdForName(ws.id, roleName);
  await sql`
    insert into workspace_members (workspace_id, user_id, role_id, active)
    values (${ws.id}, ${userId}, ${roleId}, true)
    on conflict (workspace_id, user_id) do update set active = true
  `;

  // Read back the member's effective role (their existing one if they predated
  // this sign-in, else the one we just assigned).
  const [member] = await sql<{ role_name: string | null; is_admin: boolean | null }[]>`
    select r.name as role_name, r.is_admin
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
    suspended: Boolean(ws.suspended_at),
  };
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
