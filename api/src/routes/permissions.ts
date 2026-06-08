import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.ts';
import { getDb } from '../lib/db.ts';

// Migration to Neon — Step 3. Permissions are a global catalogue (no
// workspace_id); any authenticated user may read it.
export const permissions = new Hono();

permissions.use('*', requireAuth);

permissions.get('/', async (c) => {
  const sql = getDb();
  const rows = await sql`select key, label from permissions order by key asc`;
  return c.json({ permissions: rows });
});
