// Read-only production inspector.
//
// Prints a summary of the live Neon DB so we can see what's already there
// before bootstrapping (workspaces, platform admins, whether a given admin
// email exists). It runs ONLY SELECTs — it never writes. Intended to be run
// from the `Prod inspect (Neon)` GitHub workflow, which injects the prod
// DATABASE_URL from the `production` environment secret, so the connection
// string never leaves CI.
//
// Usage (from api/):  bun run scripts/prod-inspect.ts
// Requires DATABASE_URL in the environment.
//
// Self-contained on purpose (like migrate.ts): reads DATABASE_URL straight
// from the environment and opens its own connection, so it does NOT pull in
// the full env schema.
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('✗ DATABASE_URL is not set.');
  process.exit(1);
}

// Optional: an email to check for specifically (e.g. the intended platform
// admin). Defaults to the project owner.
const CHECK_EMAIL = process.env.CHECK_EMAIL ?? 'jodi@weezboo.com';

const sql = postgres(DATABASE_URL, { ssl: 'require', max: 1, prepare: false });

async function main() {
  console.log('=== PROD INSPECT (read-only) ===\n');

  // Totals
  const [{ count: userCount }] =
    await sql`select count(*)::int as count from users where deleted_at is null`;
  const [{ count: wsCount }] =
    await sql`select count(*)::int as count from workspaces where deleted_at is null`;
  const [{ count: ticketCount }] = await sql`select count(*)::int as count from tickets`;
  // Workspaces/users exclude soft-deleted rows; tickets are a raw total
  // (the tickets table has no soft-delete column).
  console.log(
    `Totals: ${wsCount} workspace(s) + ${userCount} user(s) (excl. soft-deleted), ${ticketCount} ticket(s) (all)\n`,
  );

  // Workspaces with member + ticket counts
  const workspaces = await sql`
    select w.id, w.slug, w.name, w.plan, w.created_at, w.deleted_at,
           (select count(*)::int from workspace_members m where m.workspace_id = w.id) as members,
           (select count(*)::int from tickets t where t.workspace_id = w.id) as tickets
    from workspaces w
    order by w.created_at asc
  `;
  console.log('--- Workspaces ---');
  for (const w of workspaces) {
    const del = w.deleted_at ? '  [SOFT-DELETED]' : '';
    console.log(
      `  ${w.slug}  "${w.name}"  plan=${w.plan}  members=${w.members}  tickets=${w.tickets}  created=${w.created_at.toISOString().slice(0, 10)}  id=${w.id}${del}`,
    );
  }
  console.log('');

  // Platform admins
  const admins = await sql`
    select id, email, name, created_at, deleted_at
    from users
    where is_platform_admin = true
    order by created_at asc
  `;
  console.log(`--- Platform admins (${admins.length}) ---`);
  if (admins.length === 0) {
    console.log('  (none) — no platform-admin exists yet; the god panel is unreachable.');
  }
  for (const a of admins) {
    const del = a.deleted_at ? '  [SOFT-DELETED]' : '';
    console.log(`  ${a.email}  "${a.name}"  created=${a.created_at.toISOString().slice(0, 10)}  id=${a.id}${del}`);
  }
  console.log('');

  // The specific email we care about
  // Better Auth stores an email/password login as an `account` row with
  // providerId = 'credential' and a non-null password hash. A Maestro OAuth
  // link is a different providerId, so this tells us whether the user can sign
  // in with a password specifically.
  const [target] = await sql`
    select u.id, u.email, u.name, u.is_platform_admin, u.deleted_at,
           (
             select count(*)::int from "account" a
             where a."userId" = u.id and a."providerId" = 'credential' and a."password" is not null
           ) as password_logins,
           (select count(*)::int from "account" a where a."userId" = u.id) as total_accounts
    from users u
    where u.email = ${CHECK_EMAIL}
  `;
  console.log(`--- Target admin (${CHECK_EMAIL}) ---`);
  if (!target) {
    console.log(`  NOT FOUND — needs to be created (Better Auth sign-up) + promoted.`);
  } else {
    const cred =
      target.password_logins > 0
        ? 'yes (password set — can sign in)'
        : 'NO password (needs a set-password / reset link)';
    console.log(
      `  FOUND  is_platform_admin=${target.is_platform_admin}  ${cred}  linked_accounts=${target.total_accounts}  id=${target.id}${target.deleted_at ? '  [SOFT-DELETED]' : ''}`,
    );
  }
  console.log('');

  // Workspace memberships for the target email. The "+ Invite Agent" button
  // (web/js/agents/index.js) only renders for a workspace ADMIN — a member
  // whose role has is_admin = true — so this shows, per workspace, whether the
  // target can actually invite agents there. Platform-admin is a separate,
  // cross-workspace flag and does NOT imply workspace membership.
  const memberships = await sql`
    select w.slug, w.name, r.name as role, r.is_admin, m.active
    from workspace_members m
    join workspaces w on w.id = m.workspace_id
    join roles r      on r.id = m.role_id
    join users u      on u.id = m.user_id
    where u.email = ${CHECK_EMAIL}
    order by w.created_at asc
  `;
  console.log(`--- Workspace memberships for ${CHECK_EMAIL} (${memberships.length}) ---`);
  if (memberships.length === 0) {
    console.log('  (none) — not a member of any workspace; cannot invite agents until added to one.');
  }
  for (const m of memberships) {
    console.log(
      `  ${m.slug}  "${m.name}"  role="${m.role}"  is_admin=${m.is_admin}  active=${m.active}`,
    );
  }
  console.log('\n=== end ===');
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
