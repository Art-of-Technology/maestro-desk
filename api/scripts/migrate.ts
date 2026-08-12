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

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('✗ DATABASE_URL is not set. Add it to api/.env (see api/.env.example).');
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
  // This runs on every container boot; without this, `create table if not
  // exists schema_migrations` dumps a NOTICE object into the deploy log each
  // time. Errors are unaffected.
  onnotice: () => {},
});

// App-wide advisory lock so two concurrently booting containers (e.g. a
// rolling deploy) can't interleave migrations. Session-scoped: released
// automatically when this connection closes, even on crash.
const MIGRATE_LOCK_KEY = 727_573_707;

async function main() {
  await sql`select pg_advisory_lock(${MIGRATE_LOCK_KEY})`;
  await sql`
    create table if not exists schema_migrations (
      filename   text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  const applied = new Set(
    (await sql`select filename from schema_migrations`).map((r) => r.filename as string),
  );

  let files: string[];
  try {
    files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    throw new Error(`Could not read ${migrationsDir} — does db/migrations/ exist yet?`);
  }

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    console.log(`✓ Up to date — ${applied.size} migration(s) already applied, nothing to do.`);
    return;
  }

  console.log(`Applying ${pending.length} migration(s)…`);
  for (const file of pending) {
    const content = readFileSync(join(migrationsDir, file), 'utf8');
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(content);
        await tx`insert into schema_migrations (filename) values (${file})`;
      });
      console.log(`  ✓ ${file}`);
    } catch (err) {
      console.error(`  ✗ ${file} failed — rolled back. Nothing after this was applied.`);
      throw err;
    }
  }
  console.log(`✓ Done — applied ${pending.length} migration(s).`);
}

// Always close the pool, on success or failure, so the process exits cleanly
// (a lingering connection would otherwise keep the event loop alive). Set a
// non-zero exit code on failure rather than process.exit() mid-run, so the
// finally block still runs.
try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
