import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.ts';

export const customers = new Hono();

customers.use('*', requireAuth);

// List customers in the active workspace. Returns the raw DB shape; the SPA
// remaps fields to its data.js-style camelCase view model on the client.
//
// No pagination yet — workspaces are small in v1 and the SPA loads the full
// list on sign-in for client-side filtering. Switch to keyset pagination
// before this hits real-customer scale.
//
// Uses sbUser (user-scoped JWT client) so RLS gates the read against the
// caller's workspace_ids claim; the .eq('workspace_id', workspaceId)
// still scopes to the active workspace within that membership set.
customers.get('/', async (c) => {
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');

  const { data, error } = await sb
    .from('customers')
    .select(
      'id, display_id, first_name, last_name, username, email, mobile, brand, vip_tier, jurisdiction, consent, kyc_status, since, backoffice_url, erased_at, created_at, email_bounce_state, email_last_bounce_type, email_last_bounce_at, email_bounce_count',
    )
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .order('display_id', { ascending: true });

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ customers: data });
});
