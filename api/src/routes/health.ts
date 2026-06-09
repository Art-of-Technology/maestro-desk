import type { Context } from 'hono';
import { Hono } from 'hono';
import { getDb } from '../lib/db.ts';

export const health = new Hono();

// Cheap liveness probe — no DB roundtrip.
health.get('/', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

// Readiness — proves the API can reach Neon (the source of truth post-
// migration) and that the ported schema is present. /ready/neon is kept as
// an alias for any monitoring wired up during the migration.
async function neonReadiness(c: Context) {
  try {
    const sql = getDb();
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int from workspaces
    `;
    return c.json({ ok: true, db: 'neon', workspaces: count });
  } catch (err) {
    // Log the detail server-side; don't leak connection/internal detail to the
    // client in the probe response.
    console.error('[health] neon readiness check failed:', err);
    return c.json({ ok: false, db: 'neon', error: 'database unavailable' }, 503);
  }
}

health.get('/ready', neonReadiness);
health.get('/ready/neon', neonReadiness);
