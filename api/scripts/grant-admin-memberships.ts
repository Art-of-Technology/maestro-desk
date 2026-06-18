// Grant a platform admin an Admin membership on every brand (workspace).
//
// A platform admin (god) already has admin *capability* everywhere — the API's
// requireWorkspaceAdmin allows `ws_admin OR platform_admin`. This script
// materializes that as explicit workspace_members rows so the god also shows up
// in each brand's agent roster and is treated as a first-class Admin member.
//
// Safe by construction:
//   - WRITES, but idempotent: re-running is a no-op once memberships exist.
//   - GUARD: only acts on a user who is ALREADY is_platform_admin = true, so it
//     can never be used to escalate an arbitrary account.
//   - Skips the system (__unrouted) bucket and soft-deleted workspaces.
//   - Per-workspace it attaches the workspace's own Admin role (is_admin = true);
//     a workspace with no admin role is reported and skipped, never guessed.
//   - All changes run in ONE transaction — all or nothing.
//   - Writes an audit_events row per grant. actor_user_id is the platform
//     admin being granted; the GitHub operator who dispatched the run is
//     recorded separately in metadata.dispatched_by for traceability.
//
// Run from the `Grant platform-admin memberships (Neon)` workflow, which injects
// the prod DATABASE_URL from the `production` environment secret. Self-contained
// (like migrate.ts / prod-inspect.ts): reads DATABASE_URL straight from the env.
//
// Usage (from api/):  bun run scripts/grant-admin-memberships.ts
// Env: DATABASE_URL (required), TARGET_EMAIL (optional, defaults to the owner).
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('✗ DATABASE_URL is not set.');
  process.exit(1);
}

const TARGET_EMAIL = (process.env.TARGET_EMAIL ?? 'jodi@weezboo.com').toLowerCase();

const sql = postgres(DATABASE_URL, { ssl: 'require', max: 1, prepare: false });

async function main() {
  console.log('=== GRANT PLATFORM-ADMIN MEMBERSHIPS ===\n');
  console.log(`Target: ${TARGET_EMAIL}\n`);

  // 1. Resolve the target user and enforce the platform-admin guard.
  const [user] = await sql<{ id: string; is_platform_admin: boolean | null; deleted_at: string | null }[]>`
    select id, is_platform_admin, deleted_at from users where email = ${TARGET_EMAIL}
  `;
  if (!user) {
    console.error(`✗ No user with email ${TARGET_EMAIL}.`);
    process.exit(1);
  }
  if (user.deleted_at) {
    console.error(`✗ User ${TARGET_EMAIL} is soft-deleted — refusing.`);
    process.exit(1);
  }
  if (!user.is_platform_admin) {
    console.error(`✗ ${TARGET_EMAIL} is not a platform admin — refusing (this script only materializes memberships for an existing god).`);
    process.exit(1);
  }

  // 2. Every real brand: skip the system bucket and soft-deleted rows.
  const workspaces = await sql<{ id: string; slug: string; name: string }[]>`
    select id, slug, name from workspaces
    where is_unrouted_bucket = false and deleted_at is null
    order by created_at asc
  `;

  const created: string[] = [];
  const promoted: string[] = [];
  const alreadyAdmin: string[] = [];
  const skippedNoRole: string[] = [];

  // 3. One transaction — all or nothing.
  await sql.begin(async (tx) => {
    for (const ws of workspaces) {
      const [adminRole] = await tx<{ id: string }[]>`
        select id from roles where workspace_id = ${ws.id} and is_admin = true limit 1
      `;
      if (!adminRole) {
        skippedNoRole.push(`${ws.slug} ("${ws.name}")`);
        continue;
      }

      // Current membership (if any) — drives the audit/summary classification.
      const [existing] = await tx<{ role_id: string; active: boolean; is_admin: boolean | null }[]>`
        select wm.role_id, wm.active, r.is_admin
        from workspace_members wm
        left join roles r on r.id = wm.role_id
        where wm.workspace_id = ${ws.id} and wm.user_id = ${user.id}
      `;

      if (existing && existing.is_admin && existing.active) {
        alreadyAdmin.push(`${ws.slug} ("${ws.name}")`);
        continue;
      }

      await tx`
        insert into workspace_members (workspace_id, user_id, role_id, active)
        values (${ws.id}, ${user.id}, ${adminRole.id}, true)
        on conflict (workspace_id, user_id) do update
          set role_id = excluded.role_id, active = true
      `;

      (existing ? promoted : created).push(`${ws.slug} ("${ws.name}")`);

      await tx`
        insert into audit_events (workspace_id, actor_user_id, action, target_type, target_id, metadata)
        values (
          ${ws.id}, ${user.id}, 'brand.admin_membership_granted', 'user', ${user.id},
          ${tx.json({ email: TARGET_EMAIL, role_id: adminRole.id, via: 'grant-admin-memberships', dispatched_by: process.env.GITHUB_ACTOR ?? null, was_member: Boolean(existing) })}
        )
      `;
    }
  });

  // 4. Summary.
  const line = (label: string, items: string[]) => {
    console.log(`${label} (${items.length})`);
    for (const i of items) console.log(`  - ${i}`);
  };
  line('Created admin membership', created);
  line('Promoted to admin (was a member at another role / inactive)', promoted);
  line('Already an active admin — unchanged', alreadyAdmin);
  if (skippedNoRole.length) line('SKIPPED — no admin role on workspace (provisioning anomaly)', skippedNoRole);
  console.log(`\nDone: ${workspaces.length} brand(s) examined, ${created.length + promoted.length} changed.`);
  console.log('=== end ===');
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
