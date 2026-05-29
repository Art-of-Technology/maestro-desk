import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';

export const savedSearches = new Hono();

savedSearches.use('*', requireAuth);

// Saved searches use sbUser end-to-end — RLS (user_id = auth.uid()
// AND is_workspace_member) handles both the per-user gate and the
// workspace scope, so the route just trusts the policy and doesn't
// re-check workspace_id in the WHERE clauses.

// Filters JSON. We accept a loosely-typed object so the UI can add
// new filter dimensions (e.g. a date range, a sentiment-trend window)
// without forcing a schema bump. The known keys are validated as the
// SPA-shape strings; anything outside the schema is rejected by
// .strict() so we don't accidentally store junk.
const Filters = z.object({
  status:    z.string().max(40).optional(),
  category:  z.string().max(80).optional(),
  priority:  z.string().max(40).optional(),
  agent:     z.string().max(120).optional(),
  sentiment: z.string().max(40).optional(),
  view:      z.string().max(40).optional(),
  query:     z.string().max(200).optional(),
}).strict();

const CreateBody = z.object({
  name:    z.string().min(1).max(100),
  filters: Filters,
});

const PatchBody = z.object({
  name:    z.string().min(1).max(100).optional(),
  filters: Filters.optional(),
}).strict();

savedSearches.get('/', async (c) => {
  const sb = c.get('sbUser');
  const { data, error } = await sb
    .from('saved_searches')
    .select('id, name, filters, created_at, updated_at')
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ saved_searches: data || [] });
});

savedSearches.post('/', async (c) => {
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');
  const userId      = c.get('userId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = CreateBody.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);

  const { data, error } = await sb
    .from('saved_searches')
    .insert({
      workspace_id: workspaceId,
      user_id:      userId,
      name:         parsed.data.name,
      filters:      parsed.data.filters,
    })
    .select('id, name, filters, created_at, updated_at')
    .single();
  if (error) {
    // Unique-violation on (workspace_id, user_id, lower(name)) → 409
    if ((error as any).code === '23505') {
      return c.json({ error: 'A saved search with that name already exists' }, 409);
    }
    return c.json({ error: error.message }, 500);
  }
  return c.json({ saved_search: data }, 201);
});

savedSearches.patch('/:id', async (c) => {
  const sb = c.get('sbUser');
  const id = c.req.param('id');
  const reqBody = await c.req.json().catch(() => null);
  const parsed = PatchBody.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: 'No fields to update' }, 400);

  const { data, error } = await sb
    .from('saved_searches')
    .update(parsed.data)
    .eq('id', id)
    .select('id, name, filters, created_at, updated_at')
    .maybeSingle();
  if (error) {
    if ((error as any).code === '23505') {
      return c.json({ error: 'A saved search with that name already exists' }, 409);
    }
    return c.json({ error: error.message }, 500);
  }
  if (!data) return c.json({ error: 'Saved search not found' }, 404);
  return c.json({ saved_search: data });
});

savedSearches.delete('/:id', async (c) => {
  const sb = c.get('sbUser');
  const id = c.req.param('id');
  const { error } = await sb.from('saved_searches').delete().eq('id', id);
  if (error) return c.json({ error: error.message }, 500);
  return new Response(null, { status: 204 });
});
