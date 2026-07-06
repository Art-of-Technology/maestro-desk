// DB-backed regression test for security-audit finding #2:
// an admin's deactivation of an agent must survive a Sign-in-with-Maestro
// re-login. resolveBrandWorkspace() must NOT flip workspace_members.active back
// to true for an existing (deactivated) member, and select-brand relies on the
// returned `active` flag to reject them.
//
//   RUN_DB_TESTS=1 DATABASE_URL='…?sslmode=disable' bun test src/maestro-deactivation.test.ts

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MaestroBrand } from './lib/maestro.js';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('durable agent deactivation (DB-backed)', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let resolveBrandWorkspace: typeof import('./lib/maestro-workspace.js').resolveBrandWorkspace;
  const RUN = Date.now();
  const brandId = randomUUID();   // maestro_brand_id is a uuid column
  let wsId: string;
  let roleId: string;
  const createdUserIds: string[] = [];

  const signUp = async (email: string): Promise<string> => {
    const { auth } = await import('./lib/auth.js');
    const r: any = await auth.api.signUpEmail({ body: { email, password: 'password-12345', name: email }, returnHeaders: true });
    createdUserIds.push(r.response.user.id);
    return r.response.user.id;
  };
  const memberActive = async (userId: string): Promise<boolean | undefined> => {
    const [row] = await sql<{ active: boolean }[]>`
      select active from workspace_members where workspace_id = ${wsId} and user_id = ${userId}`;
    return row?.active;
  };
  // Minimal brand payload — resolveBrandWorkspace only reads id/name/slug/logoUrl.
  const brand: MaestroBrand = { id: brandId, name: `Brand ${RUN}`, slug: `md-${RUN}`, logoUrl: null };

  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb();
    resolveBrandWorkspace = (await import('./lib/maestro-workspace.js')).resolveBrandWorkspace;
    // Provision a workspace and tag it as the projection of our Maestro brand so
    // resolveBrandWorkspace finds it instead of provisioning a fresh one.
    const slug = `md-${RUN}`;
    const [{ provision_brand: id }] = await sql<{ provision_brand: string }[]>`select provision_brand(${slug}, ${slug}) as provision_brand`;
    wsId = id;
    await sql`update workspaces set maestro_brand_id = ${brandId} where id = ${wsId}`;
    const [role] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${wsId} and name = 'Admin'`;
    roleId = role.id;
  });

  afterAll(async () => {
    if (!sql) return;
    if (wsId) await sql`delete from workspaces where id = ${wsId}`;
    if (createdUserIds.length) await sql`delete from users where id in ${sql(createdUserIds)}`;
  });

  it('does NOT reactivate an admin-deactivated member on Maestro re-login', async () => {
    const uid = await signUp(`md-deact-${RUN}@t.test`);
    // Admin deactivated this agent.
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsId}, ${uid}, ${roleId}, false)`;

    const membership = await resolveBrandWorkspace(uid, brand, 'Admin');

    expect(await memberActive(uid)).toBe(false);   // row stays deactivated
    expect(membership.active).toBe(false);          // select-brand will 403 on this
  });

  it('provisions a brand-new member as active', async () => {
    const uid = await signUp(`md-new-${RUN}@t.test`);

    const membership = await resolveBrandWorkspace(uid, brand, 'Admin');

    expect(await memberActive(uid)).toBe(true);
    expect(membership.active).toBe(true);
  });

  it('leaves an already-active member active', async () => {
    const uid = await signUp(`md-active-${RUN}@t.test`);
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsId}, ${uid}, ${roleId}, true)`;

    const membership = await resolveBrandWorkspace(uid, brand, 'Admin');

    expect(await memberActive(uid)).toBe(true);
    expect(membership.active).toBe(true);
  });
});
