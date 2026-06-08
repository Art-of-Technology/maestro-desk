import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.ts';
import { getDb } from '../lib/db.ts';

// Migration to Neon — Step 3. Member-level, workspace-scoped via getDb().
export const customers = new Hono();

customers.use('*', requireAuth);

// List customers in the active workspace. Returns the raw DB shape; the SPA
// remaps to its camelCase view model. No pagination yet (small in v1).
customers.get('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const rows = await sql`
    select id, display_id, first_name, last_name, username, email, mobile, brand, vip_tier,
           jurisdiction, consent, kyc_status, since, backoffice_url, erased_at, created_at,
           email_bounce_state, email_last_bounce_type, email_last_bounce_at, email_bounce_count
    from customers
    where workspace_id = ${workspaceId} and deleted_at is null
    order by display_id asc
  `;
  return c.json({ customers: rows });
});
