import { Hono } from 'hono';
import { supabaseAdmin } from '../lib/supabase.ts';
import { getDb } from '../lib/db.ts';

export const health = new Hono();

// Cheap liveness probe — no DB roundtrip.
health.get('/', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

// Readiness — proves the API can reach Supabase + the schema is the one we expect.
health.get('/ready', async (c) => {
  const { count, error } = await supabaseAdmin
    .from('workspaces')
    .select('*', { count: 'exact', head: true });
  if (error) return c.json({ ok: false, error: error.message }, 503);
  return c.json({ ok: true, workspaces: count ?? 0 });
});

// Neon readiness (migration to Neon — Step 1). Proves the API can reach the
// new database with raw SQL and that the ported schema is present. Separate
// from /ready so the live Supabase probe is untouched during the migration.
health.get('/ready/neon', async (c) => {
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
});
