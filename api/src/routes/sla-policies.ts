import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';

export const slaPolicies = new Hono();

slaPolicies.use('*', requireAuth);

function nextDisplayId(): string {
  return `SLA-${String(Math.floor(Math.random() * 9000 + 1000))}`;
}

// category_key is nullable for "any category" — the SPA models this as
// 'all'; the API uses null. Translation happens client-side.
const PolicyBody = z.object({
  name:               z.string().min(1).max(200),
  priority_key:       z.enum(['urgent', 'high', 'normal', 'low']),
  category_key:       z.string().nullable().optional(),
  first_response_min: z.number().int().positive(),
  resolution_min:     z.number().int().positive(),
  status:             z.enum(['active', 'inactive']).optional(),
}).refine((d) => d.resolution_min >= d.first_response_min, {
  message: 'resolution_min must be at least first_response_min',
});

slaPolicies.get('/', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');

  const { data, error } = await sb
    .from('sla_policies')
    .select('id, display_id, name, priority_key, category_key, first_response_min, resolution_min, status, created_at, updated_at')
    .eq('workspace_id', workspaceId)
    .order('display_id', { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ sla_policies: data });
});

slaPolicies.post('/', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PolicyBody.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  const { data, error } = await sb
    .from('sla_policies')
    .insert({
      workspace_id:       workspaceId,
      display_id:         nextDisplayId(),
      name:               input.name,
      priority_key:       input.priority_key,
      category_key:       input.category_key ?? null,
      first_response_min: input.first_response_min,
      resolution_min:     input.resolution_min,
      status:             input.status ?? 'active',
    })
    .select('id, display_id, name, priority_key, category_key, first_response_min, resolution_min, status, created_at, updated_at')
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ sla_policy: data }, 201);
});

const PatchPolicy = z.object({
  name:               z.string().min(1).max(200).optional(),
  priority_key:       z.enum(['urgent', 'high', 'normal', 'low']).optional(),
  category_key:       z.string().nullable().optional(),
  first_response_min: z.number().int().positive().optional(),
  resolution_min:     z.number().int().positive().optional(),
  status:             z.enum(['active', 'inactive']).optional(),
}).strict();

slaPolicies.patch('/:id', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PatchPolicy.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  // Cross-field validation: if either min is touched, the result must
  // still satisfy resolution_min >= first_response_min. Pull the current
  // row to check the un-touched side.
  if (parsed.data.first_response_min !== undefined || parsed.data.resolution_min !== undefined) {
    const { data: current, error: lookupErr } = await sb
      .from('sla_policies')
      .select('first_response_min, resolution_min')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (lookupErr) return c.json({ error: lookupErr.message }, 500);
    if (!current)  return c.json({ error: 'SLA policy not found' }, 404);
    const nextFirst = parsed.data.first_response_min ?? current.first_response_min;
    const nextRes   = parsed.data.resolution_min     ?? current.resolution_min;
    if (nextRes < nextFirst) {
      return c.json({ error: 'resolution_min must be at least first_response_min' }, 400);
    }
  }

  const { data, error } = await sb
    .from('sla_policies')
    .update(parsed.data)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select('id, display_id, name, priority_key, category_key, first_response_min, resolution_min, status, updated_at')
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data)  return c.json({ error: 'SLA policy not found' }, 404);
  return c.json({ sla_policy: data });
});

slaPolicies.delete('/:id', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const { error } = await sb
    .from('sla_policies')
    .delete()
    .eq('id', id)
    .eq('workspace_id', workspaceId);
  if (error) return c.json({ error: error.message }, 500);
  return new Response(null, { status: 204 });
});
