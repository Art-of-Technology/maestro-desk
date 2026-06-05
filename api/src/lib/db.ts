import postgres from 'postgres';
import { env } from './env.ts';

// Neon Postgres connection (migration to Neon — Step 1).
//
// This is the new raw-SQL data-access path. Use it via tagged templates:
//   const sql = getDb();
//   const rows = await sql`select id, name from workspaces where id = ${id}`;
// postgres.js parameterises ${...} values automatically — they are NOT string
// interpolation, so this is safe against SQL injection. Never build SQL by
// concatenating strings; always interpolate values through the tag.
//
// Lazy + memoised: importing this module never opens a connection or throws,
// so the API still boots while DATABASE_URL is unset (Supabase remains the
// live DB during the migration). The connection is created on first use, and
// reused after that.
let _sql: ReturnType<typeof postgres> | null = null;

export function getDb() {
  if (!env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set — the Neon connection is unavailable. ' +
        'Add it to api/.env (see api/.env.example) using your Neon connection string.',
    );
  }
  if (!_sql) {
    _sql = postgres(env.DATABASE_URL, {
      // Neon requires TLS.
      ssl: 'require',
      // Keep the pool small — the API runs as short-lived serverless
      // functions on Vercel (target stack), so a large pool is wasteful.
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
      // Disable prepared statements: Neon's pooled (PgBouncer, transaction
      // mode) connection string does not support them. Safe for the direct
      // connection too.
      prepare: false,
    });
  }
  return _sql;
}
