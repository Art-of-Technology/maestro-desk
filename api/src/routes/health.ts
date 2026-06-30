import type { Context } from 'hono';
import { Hono } from 'hono';
import { getDb } from '../lib/db.js';

export const health = new Hono();

// Cheap liveness probe — no DB roundtrip.
health.get('/', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

// Readiness — proves the API can reach Neon (the source of truth post-
// migration) and that the ported schema is present. /ready/neon is kept as
// an alias for any monitoring wired up during the migration.
async function neonReadiness(c: Context) {
  try {
    const sql = getDb();
    // Touch a workspace-scoped table to prove the schema is present, but do NOT
    // return the platform-wide tenant count — that's a business-metric leak to
    // an unauthenticated caller (advisory #18).
    await sql`select 1 from workspaces limit 1`;
    return c.json({ ok: true, db: 'neon' });
  } catch (err) {
    // Log the detail server-side; don't leak connection/internal detail to the
    // client in the probe response.
    console.error('[health] neon readiness check failed:', err);
    return c.json({ ok: false, db: 'neon', error: 'database unavailable' }, 503);
  }
}

health.get('/ready', neonReadiness);
health.get('/ready/neon', neonReadiness);
