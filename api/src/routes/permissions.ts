import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.ts';

export const permissions = new Hono();

permissions.use('*', requireAuth);

// Permissions are a global catalogue (no workspace_id) — every workspace
// sees the same set. Anyone authed in any workspace can read it.
permissions.get('/', async (c) => {
  const sb = c.get('sb');
  const { data, error } = await sb
    .from('permissions')
    .select('key, label')
    .order('key', { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ permissions: data });
});
