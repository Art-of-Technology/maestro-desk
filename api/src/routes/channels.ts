import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.ts';
import { getDb } from '../lib/db.ts';

// Migration to Neon — Step 3. Member-level, workspace-scoped via getDb().
export const channels = new Hono();

channels.use('*', requireAuth);

// List channels with the default-assigned user's name joined so the SPA can
// show "default agent" without a second round-trip.
channels.get('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const rows = await sql`
    select ch.id, ch.display_id, ch.name, ch.type, ch.address, ch.status,
           ch.default_category_key, ch.signature, ch.volume_30d,
           u.name as default_agent_name
    from channels ch
    left join users u on u.id = ch.default_assigned_user_id
    where ch.workspace_id = ${workspaceId}
    order by ch.display_id asc
  `;
  const channels = rows.map((row) => ({
    id:                   row.id,
    display_id:           row.display_id,
    name:                 row.name,
    type:                 row.type,
    address:              row.address,
    status:               row.status,
    default_category_key: row.default_category_key,
    default_agent_name:   row.default_agent_name ?? null,
    signature:            row.signature || '',
    volume_30d:           row.volume_30d || 0,
  }));
  return c.json({ channels });
});
