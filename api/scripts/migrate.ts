// Migration runner.
//
// Applies every *.sql file in db/migrations/ (repo root), in filename order,
// exactly once. Each file runs inside a transaction; a record is written to
// the schema_migrations table so re-runs skip already-applied files.
//
// Runs under BOTH runtimes on purpose (no Bun-only APIs):
//  - Bun:  `bun run migrate` from api/ (local dev, CI, staging workflow)
//  - Node: `node --import tsx scripts/migrate.ts` — production runs this at
//    container boot on Dokploy, before the server starts (the deploy fails
//    visibly if a migration fails; the previous image keeps serving).
//
// Self-contained on purpose: it reads DATABASE_URL straight from the
// environment and opens its own connection, so it does NOT pull in the full
// env schema (no need for Anthropic/Postmark vars just to run migrations).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { safeError } from '../src/lib/diagnostics.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(
    '✗ DATABASE_URL is not set. Add it to api/.env (see api/.env.example).',
  );
  process.exit(1);
}

// api/scripts/ -> repo root -> db/migrations. The production image mirrors
// this layout (/app/api/scripts + /app/db/migrations) so the same path math
// works in the repo and in the container. import.meta.dirname works on both
// Node >=20.11 and Bun (import.meta.dir is Bun-only).
const migrationsDir = join(import.meta.dirname, '..', '..', 'db', 'migrations');

// A TLS-carrying URL (sslmode=require) needs ssl; a local/CI/Dokploy-internal
// Postgres has no TLS, so honour an explicit sslmode=disable and skip it there.
const sql = postgres(DATABASE_URL, {
  ssl: DATABASE_URL.includes('sslmode=disable') ? false : 'require',
  max: 1,
  prepare: false,
  // Notices can interpolate database values. Keep migration filenames/progress
  // and filtered failures below, but suppress routine server notice text.
  onnotice: () => {},
});

// App-wide advisory lock so two concurrently booting containers (e.g. a
// rolling deploy) can't double-apply a file. TRANSACTION-scoped
// (pg_advisory_xact_lock) on purpose: a session-level pg_advisory_lock is
// unsafe through a transaction-mode pooler (PgBouncer / Neon's -pooler
// endpoint, which this runner still targets until the Dokploy DB cutover
// completes and for staging) — the lock sticks to whichever backend the
// pooler picked and outlives the client, so a later boot can block forever.
// An xact lock lives and dies with its transaction on one backend, which is
// pooler-safe; it is taken inside each file's transaction below.
const MIGRATE_LOCK_KEY = 727_573_707;

// Bounded wait for the advisory lock: if another migrator hangs while holding
// it, fail this boot loudly (deploy turns red, previous image keeps serving)
// instead of blocking inside the container CMD forever. `set local` scopes the
// timeout to the surrounding transaction only — the migration statements that
// follow keep the server default.
async function takeLock(tx: { unsafe: (q: string) => Promise<unknown> }) {
  await tx.unsafe(`set local lock_timeout = '120s'`);
  await tx.unsafe(`select pg_advisory_xact_lock(${MIGRATE_LOCK_KEY})`);
}

async function main() {
  const mode = process.env.DATABASE_BOOT_MODE ?? 'migrate';
  if (!['migrate', 'check'].includes(mode))
    throw Error('DATABASE_BOOT_MODE must be migrate or check');
  if (mode === 'check') {
    await sql.begin('read only', async (tx) => {
      const applied = new Set(
        (await tx`select filename from schema_migrations`).map(
          (r) => r.filename,
        ),
      );
      const pending = readdirSync(migrationsDir).filter(
        (f) => f.endsWith('.sql') && !applied.has(f),
      );
      if (pending.length)
        throw Error(
          'Pending database migrations; run the separate migration job before starting the API',
        );
      const [role] =
        await tx`select r.rolsuper,r.rolcreaterole,r.rolcreatedb,r.rolreplication,r.rolbypassrls,
        exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and pg_has_role(current_user,c.relowner,'MEMBER')) as owns_objects,
        exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and pg_has_role(current_user,p.proowner,'MEMBER')) as owns_functions,
        exists(select 1 from pg_auth_members m where m.member=r.oid) as has_memberships,
        has_schema_privilege(current_user,'public','CREATE') as can_create,
        has_database_privilege(current_user,current_database(),'CREATE') as can_create_schema,
        has_database_privilege(current_user,current_database(),'TEMP') as can_temp,
        has_parameter_privilege(current_user,'session_replication_role','SET') as can_disable_guards,
        has_table_privilege(current_user,'audit_events','UPDATE,DELETE,TRUNCATE') as can_rewrite_audit,
        has_table_privilege(current_user,'audit_verify_checkpoints','INSERT,UPDATE,DELETE,TRUNCATE') as can_forge_checkpoints
        from pg_roles r where r.rolname=current_user`;
      const excessive = Object.keys(role).filter((key) => role[key]);
      if (excessive.length) {
        // Fixed query aliases only: never log role names, connection URLs or SQL errors.
        console.error(
          'Restricted runtime permission checks failed:',
          excessive.join(', '),
        );
        throw Error('Restricted runtime has excessive database permissions');
      }
    });
    console.log(
      'Database schema and restricted runtime permissions verified. No migrations applied.',
    );
    return;
  }
  // Bootstrap under the same lock: `if not exists` alone is not fully
  // race-proof — two connections creating the table simultaneously can still
  // collide in the catalog and one of them errors, crashing that boot.
  await sql.begin(async (tx) => {
    await takeLock(tx);
    await tx`
      create table if not exists schema_migrations (
        filename   text primary key,
        applied_at timestamptz not null default now()
      )
    `;
  });

  const applied = new Set(
    (await sql`select filename from schema_migrations`).map(
      (r) => r.filename as string,
    ),
  );

  let files: string[];
  try {
    files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    throw new Error(
      `Could not read ${migrationsDir} — does db/migrations/ exist yet?`,
    );
  }

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    console.log(
      `✓ Up to date — ${applied.size} migration(s) already applied, nothing to do.`,
    );
    return;
  }

  console.log(`Applying ${pending.length} migration(s)…`);
  let appliedNow = 0;
  for (const file of pending) {
    const content = readFileSync(join(migrationsDir, file), 'utf8');
    try {
      const did = await sql.begin(async (tx) => {
        await takeLock(tx);
        // Re-check under the lock: a concurrent migrator may have applied this
        // file after we computed `pending`. Skipping here (instead of hitting
        // the schema_migrations PK) keeps a racing boot from failing.
        const seen =
          await tx`select 1 from schema_migrations where filename = ${file}`;
        if (seen.length > 0) return false;
        await tx.unsafe(content);
        await tx`insert into schema_migrations (filename) values (${file})`;
        return true;
      });
      if (did) {
        appliedNow++;
        console.log(`  ✓ ${file}`);
      } else {
        console.log(`  ↷ ${file} (applied by a concurrent migrator)`);
      }
    } catch (err) {
      console.error(
        `  ✗ ${file} failed — rolled back. Nothing after this was applied.`,
      );
      throw err;
    }
  }
  console.log(`✓ Done — applied ${appliedNow} migration(s).`);
}

// Always close the pool, on success or failure, so the process exits cleanly
// (a lingering connection would otherwise keep the event loop alive). Set a
// non-zero exit code on failure rather than process.exit() mid-run, so the
// finally block still runs.
try {
  await main();
} catch (err) {
  console.error('Migration failed:', safeError(err));
  process.exitCode = 1;
} finally {
  await sql.end();
}
