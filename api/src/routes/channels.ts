import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.ts';

export const channels = new Hono();

channels.use('*', requireAuth);

// List channels in the active workspace, with the default-assigned user
// joined so the SPA can show "default agent" by name.
//
// Uses sbUser — channels was pivoted alongside inbox_messages in PR #193,
// and the users(name) embed resolves via the workspace-peer-select policy.
channels.get('/', async (c) => {
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');

  const { data, error } = await sb
    .from('channels')
    .select(`
      id, display_id, name, type, address, status,
      default_category_key, default_assigned_user_id, signature, volume_30d, created_at,
      users(name)
    `)
    .eq('workspace_id', workspaceId)
    .order('display_id', { ascending: true });

  if (error) return c.json({ error: error.message }, 500);

  const channels = (data || []).map((row: any) => ({
    id:                  row.id,
    display_id:          row.display_id,
    name:                row.name,
    type:                row.type,
    address:             row.address,
    status:              row.status,
    default_category_key: row.default_category_key,
    default_agent_name:  row.users?.name || null,
    signature:           row.signature || '',
    volume_30d:          row.volume_30d || 0,
  }));

  return c.json({ channels });
});
