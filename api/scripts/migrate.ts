// Neon migration runner (migration to Neon — Step 1).
//
// Applies every *.sql file in db/migrations/ (repo root), in filename order,
// exactly once. Each file runs inside a transaction; a record is written to
// the schema_migrations table so re-runs skip already-applied files.
//
// Usage (from api/):  bun run migrate
// Requires DATABASE_URL in api/.env (Bun auto-loads it).
//
// Self-contained on purpose: it reads DATABASE_URL straight from the
// environment and opens its own connection, so it does NOT pull in the full
// env schema (no need for Supabase/Anthropic vars just to run migrations).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('✗ DATABASE_URL is not set. Add it to api/.env (see api/.env.example).');
  process.exit(1);
}

// api/scripts/ -> repo root -> db/migrations
const migrationsDir = join(import.meta.dir, '..', '..', 'db', 'migrations');

// Neon's URL carries sslmode=require; a local/CI Postgres has no TLS, so honour
// an explicit sslmode=disable and skip it there (used when applying migrations
// to the test database in CI).
const sql = postgres(DATABASE_URL, {
  ssl: DATABASE_URL.includes('sslmode=disable') ? false : 'require',
  max: 1,
  prepare: false,
});

async function main() {
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
    const content = await Bun.file(join(migrationsDir, file)).text();
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
