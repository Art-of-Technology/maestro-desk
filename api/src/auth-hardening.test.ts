// DB-backed tests for the auth-hardening batch:
//  #21 — portal magic-link/session tokens are stored HASHED, never raw.
//  #22 — revokeSessionsIfNoAccess deletes Better Auth sessions only when the
//        user has lost all access (no active membership and not platform admin).
//
//   RUN_DB_TESTS=1 DATABASE_URL='…?sslmode=disable' bun test src/auth-hardening.test.ts

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

runDbTests('auth hardening (DB-backed)', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let portal: typeof import('./lib/portal-auth.js');
  let revokeSessionsIfNoAccess: typeof import('./lib/sessions.js').revokeSessionsIfNoAccess;
  const RUN = Date.now();
  const wsA = { slug: `ah-a-${RUN}` } as Record<string, string>;
  const wsB = { slug: `ah-b-${RUN}` } as Record<string, string>;
  const createdUserIds: string[] = [];

  async function provision(t: Record<string, string>) {
    const [{ provision_brand: id }] = await sql<{ provision_brand: string }[]>`select provision_brand(${t.slug}, ${t.slug}) as provision_brand`;
    t.wsId = id;
    const [role] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${id} and name = 'Admin'`;
    t.roleId = role.id;
  }
  async function signUp(email: string): Promise<string> {
    const { auth } = await import('./lib/auth.js');
    const r: any = await auth.api.signUpEmail({ body: { email, password: 'password-12345', name: email }, returnHeaders: true });
    createdUserIds.push(r.response.user.id);
    return r.response.user.id;
  }
  const addMember = (wsId: string, roleId: string, userId: string, active: boolean) =>
    sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsId}, ${userId}, ${roleId}, ${active})`;
  const sessionCount = async (userId: string) => {
    const [r] = await sql<{ n: number }[]>`select count(*)::int as n from "session" where "userId" = ${userId}`;
    return r.n;
  };

  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb();
    portal = await import('./lib/portal-auth.js');
    revokeSessionsIfNoAccess = (await import('./lib/sessions.js')).revokeSessionsIfNoAccess;
    await provision(wsA);
    await provision(wsB);
  });

  afterAll(async () => {
    if (!sql) return;
    const wsIds = [wsA.wsId, wsB.wsId].filter(Boolean);
    if (wsIds.length) await sql`delete from workspaces where id in ${sql(wsIds)}`;
    if (createdUserIds.length) await sql`delete from users where id in ${sql(createdUserIds)}`;
  });

  // ─── #21: tokens hashed at rest ─────────────────────────────────────────
  it('stores only the SHA-256 of portal tokens, and round-trips by raw token', async () => {
    const [cust] = await sql<{ id: string }[]>`
      insert into customers (workspace_id, display_id, first_name, email)
      values (${wsA.wsId}, ${'M-' + RUN}, 'Pat', ${'pat-' + RUN + '@t.test'}) returning id`;

    const { token } = await portal.createMagicLink({ workspaceId: wsA.wsId, customerId: cust.id });
    const [link] = await sql<{ token: string }[]>`select token from portal_magic_links where workspace_id = ${wsA.wsId} and customer_id = ${cust.id}`;
    expect(link.token).toBe(sha(token));     // hash stored
    expect(link.token).not.toBe(token);      // raw NOT stored

    const verified = await portal.verifyMagicLink({ workspaceId: wsA.wsId, token });
    expect(verified).not.toBeNull();
    const [sess] = await sql<{ token: string }[]>`select token from portal_sessions where workspace_id = ${wsA.wsId} and customer_id = ${cust.id}`;
    expect(sess.token).toBe(sha(verified!.sessionToken));

    expect((await portal.customerForSession({ workspaceId: wsA.wsId, sessionToken: verified!.sessionToken }))?.customerId).toBe(cust.id);
    expect(await portal.customerForSession({ workspaceId: wsA.wsId, sessionToken: 'not-a-real-token' })).toBeNull();
  });

  // ─── #22: revoke sessions only on total access loss ─────────────────────
  it('keeps sessions for an active member; deletes them once deactivated', async () => {
    const uid = await signUp(`ah-active-${RUN}@t.test`);
    await addMember(wsA.wsId, wsA.roleId, uid, true);
    expect(await sessionCount(uid)).toBeGreaterThan(0);

    await revokeSessionsIfNoAccess(sql, uid);
    expect(await sessionCount(uid)).toBeGreaterThan(0);   // still has access → kept

    await sql`update workspace_members set active = false where user_id = ${uid} and workspace_id = ${wsA.wsId}`;
    await revokeSessionsIfNoAccess(sql, uid);
    expect(await sessionCount(uid)).toBe(0);              // no access left → revoked
  });

  it('keeps sessions for a platform admin with no membership', async () => {
    const uid = await signUp(`ah-admin-${RUN}@t.test`);
    await sql`update users set is_platform_admin = true where id = ${uid}`;
    expect(await sessionCount(uid)).toBeGreaterThan(0);
    await revokeSessionsIfNoAccess(sql, uid);
    expect(await sessionCount(uid)).toBeGreaterThan(0);   // platform admin → kept
  });

  it('keeps sessions for a user still active in another workspace', async () => {
    const uid = await signUp(`ah-multi-${RUN}@t.test`);
    await addMember(wsA.wsId, wsA.roleId, uid, false);    // deactivated here
    await addMember(wsB.wsId, wsB.roleId, uid, true);     // but active in B
    await revokeSessionsIfNoAccess(sql, uid);
    expect(await sessionCount(uid)).toBeGreaterThan(0);   // active somewhere → kept
  });
});
