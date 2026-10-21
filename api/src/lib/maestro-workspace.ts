// Brand → workspace projection (Maestro brands are the canonical workspace).
//
// Given a Maestro brand the signed-in agent can access, return the Desk
// workspace that represents it, subject to platform approval, and make
// sure the agent has an active membership with the role their Maestro access
// implies. The rest of the app keeps using the internal workspace_id; this is
// the one place that knows a workspace IS a Maestro brand.

import { getDb } from './db.js';
import { HTTPException } from 'hono/http-exception';
import type { MaestroBrand } from './maestro.js';
import type { TransactionSql } from 'postgres';

export interface BrandWorkspace {
  workspace_id: string;
  workspace_name: string;
  workspace_slug: string;
  workspace_logo_url: string | null;
  workspace_primary_color: string | null;
  role_name: string | null;
  is_admin: boolean;
  // Shaped like whoami: admins implicitly carry both capabilities, so the
  // SPA can read these directly into SESSION at Maestro sign-in.
  can_manage_custom_fields: boolean;
  can_delete: boolean;
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
  deleted_at: string | null;
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

  const ws = await sql.begin(async tx => {
    await lockBrand(tx, brand.id);
    const existing = await findByBrand(brand.id, tx);
    if (existing) return existing;
    const [settings] = await tx`select automatic from workspace_registration_settings where id=true for share`;
    const [pending] = await tx`select maestro_brand_id from workspace_requests where maestro_brand_id=${brand.id} and approved_at is null`;
    if (!settings?.automatic || pending) {
      throw new HTTPException(403, { message: pending
        ? 'Your workspace request is awaiting approval.'
        : 'This brand needs approval before it can use Respovia. Request a workspace from the brand picker.' });
    }
    return provisionForBrand(brand, tx);
  });
  if (ws.deleted_at) throw new HTTPException(403, { message: 'This brand is archived.' });
  if (ws.suspended_at) throw new HTTPException(403, { message: 'This workspace is unavailable.' });

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
  const [member] = await sql<{ role_name: string | null; is_admin: boolean | null; can_manage_custom_fields: boolean | null; can_delete: boolean | null; active: boolean }[]>`
    select r.name as role_name, r.is_admin, r.can_manage_custom_fields, r.can_delete, wm.active
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
    // Same implicit-admin shaping as whoami — the Maestro sign-in path feeds
    // the same bootShell() that consumes whoami memberships, so the two must
    // agree or capabilities silently drop on "Continue with Maestro".
    can_manage_custom_fields: Boolean(member?.is_admin) || Boolean(member?.can_manage_custom_fields),
    can_delete: Boolean(member?.is_admin) || Boolean(member?.can_delete),
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
      and w.suspended_at is null
      and wm.user_id = ${userId}
      and wm.active = true
    limit 1
  `;
  return row?.id ?? null;
}

/**
 * Reverse of findByBrand: the Maestro brand a workspace projects, or null for
 * a non-Maestro workspace (legacy tenant, the unrouted inbound bucket). Used
 * by headless paths that have a workspace id but no signed-in agent and
 * therefore no X-Brand-Id header (player-identity linking; triage reads the
 * same column inside its own workspace-lookups query).
 */
export async function maestroBrandIdForWorkspace(workspaceId: string): Promise<string | null> {
  const sql = getDb();
  const [row] = await sql<{ maestro_brand_id: string | null }[]>`
    select maestro_brand_id from workspaces where id = ${workspaceId} and deleted_at is null and suspended_at is null
  `;
  return row?.maestro_brand_id ?? null;
}

async function findByBrand(brandId: string, sql: TransactionSql): Promise<WorkspaceRow | null> {
  const [row] = await sql<WorkspaceRow[]>`
    select id, name, slug, logo_url, primary_color, suspended_at, deleted_at from workspaces
    where maestro_brand_id = ${brandId}
    order by (deleted_at is null) desc, created_at asc limit 1
  `;
  return row ?? null;
}

async function provisionForBrand(brand: MaestroBrand, tx: TransactionSql): Promise<WorkspaceRow> {
  const name = brand.name || 'Brand';
  // Keep slugs unique-but-stable: brand slug if given, else a slug of the name,
  // suffixed with a brand-id fragment so two like-named brands don't collide.
  const baseSlug = brand.slug ? slugify(brand.slug) : slugify(name);
  const slug = `${baseSlug}-${brand.id.slice(0, 8)}`.slice(0, 60);

  // The caller locks this brand and creates its mapping in the same transaction.
  const [{ id }] = await tx<{ id: string }[]>`
    select provision_brand(${name}, ${slug}, ${null}, ${brand.logoUrl ?? null}, ${null}) as id
  `;
  await tx`update workspaces set maestro_brand_id = ${brand.id} where id = ${id}`;
  const [row] = await tx<WorkspaceRow[]>`
    select id, name, slug, logo_url, primary_color, suspended_at, deleted_at
    from workspaces where id = ${id}
  `;
  return row;
}

async function lockBrand(tx: TransactionSql, brandId: string) {
  await tx`select pg_advisory_xact_lock(hashtextextended(${brandId}, 0))`;
}

export async function requestBrandWorkspace(userId: string, brand: MaestroBrand, organizationName: string) {
  return getDb().begin(async tx => {
    await lockBrand(tx, brand.id);
    const existing = await findByBrand(brand.id, tx);
    if (existing) throw new HTTPException(409, { message: 'This brand already has a Respovia workspace.' });
    await tx`insert into workspace_requests(maestro_brand_id,brand_name,brand_slug,organization_id,organization_name,requester_id)
      values(${brand.id},${brand.name},${brand.slug ?? null},${brand.organizationId ?? null},${organizationName},${userId})
      on conflict(maestro_brand_id) do nothing`;
    return { pending: true };
  });
}

export async function approveBrandWorkspace(brandId: string, adminId: string) {
  return getDb().begin(async tx => {
    await lockBrand(tx, brandId);
    const [request] = await tx`select * from workspace_requests where maestro_brand_id=${brandId} for update`;
    if (!request) throw new HTTPException(404, { message: 'Workspace request not found.' });
    const existing = await findByBrand(brandId, tx);
    if (existing?.deleted_at || existing?.suspended_at) {
      throw new HTTPException(409, { message: 'This brand is archived or suspended.' });
    }
    if (request.approved_at) return { workspace_id: request.workspace_id };
    const ws = existing ?? await provisionForBrand({ id: brandId, name: request.brand_name, slug: request.brand_slug }, tx);
    await tx`update workspace_requests set approved_by=${adminId},approved_at=now(),workspace_id=${ws.id} where maestro_brand_id=${brandId}`;
    await tx`insert into audit_events(workspace_id,actor_user_id,action,target_type,target_id,metadata)
      values(${ws.id},${adminId},'workspace_request.approved','workspace',${ws.id},
        ${tx.json({ maestro_brand_id: brandId, requester_id: request.requester_id })})`;
    return { workspace_id: ws.id };
  });
}

export async function workspaceRegistration() {
  const sql = getDb();
  const [settings] = await sql`select automatic from workspace_registration_settings where id=true`;
  if (!settings) throw new Error('Workspace registration settings are missing');
  const requests = await sql`select r.maestro_brand_id,r.brand_name,r.organization_name,r.requested_at,u.email as requester_email
    from workspace_requests r join users u on u.id=r.requester_id
    where r.approved_at is null order by r.requested_at`;
  return { automatic: settings.automatic as boolean, requests };
}

export async function setWorkspaceRegistration(automatic: boolean, adminId: string) {
  await getDb().begin(async tx => {
    const [previous] = await tx`select automatic from workspace_registration_settings where id=true for update`;
    if (!previous) throw new Error('Workspace registration settings are missing');
    await tx`update workspace_registration_settings set automatic=${automatic},updated_by=${adminId},updated_at=now() where id=true`;
    const [bucket] = await tx`select id from workspaces where is_unrouted_bucket=true`;
    await tx`insert into audit_events(workspace_id,actor_user_id,action,target_type,metadata)
      values(${bucket.id},${adminId},'workspace_registration.updated','platform',
        ${tx.json({ automatic, previous_automatic: previous.automatic })})`;
  });
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
