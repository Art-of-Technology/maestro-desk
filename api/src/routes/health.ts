import type { Context } from 'hono';
import { Hono } from 'hono';
import { getDb } from '../lib/db.js';
import { BUILD_FINGERPRINT } from '../lib/build-info.js';

export const health = new Hono();

// Cheap liveness probe — no DB roundtrip.
health.get('/', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true, ts: new Date().toISOString(), buildFingerprint: BUILD_FINGERPRINT });
});

// Readiness — proves the API can reach Postgres (the dedicated Dokploy
// instance since the Neon migration) and that the schema is present.
// /ready/neon is kept as an alias for monitoring wired up in the Neon era
// (PROD_SETUP.md and external probes reference it).
async function dbReadiness(c: Context) {
  c.header('Cache-Control', 'no-store');
  try {
    const sql = getDb();
    // Touch a workspace-scoped table to prove the schema is present, but do NOT
    // return the platform-wide tenant count — that's a business-metric leak to
    // an unauthenticated caller (advisory #18).
    await sql`select 1 from workspaces limit 1`;
    return c.json({ ok: true, db: 'postgres', buildFingerprint: BUILD_FINGERPRINT });
  } catch (err) {
    // Log the detail server-side; don't leak connection/internal detail to the
    // client in the probe response.
    console.error('[health] db readiness check failed:', err);
    return c.json({ ok: false, db: 'postgres', error: 'database unavailable' }, 503);
  }
}

health.get('/ready', dbReadiness);
health.get('/ready/neon', dbReadiness);
