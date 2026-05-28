import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';

export const cannedResponses = new Hono();

cannedResponses.use('*', requireAuth);

function nextDisplayId(): string {
  return `TPL-${String(Math.floor(Math.random() * 9000 + 1000))}`;
}

const TemplateBody = z.object({
  name:     z.string().min(1).max(200),
  category: z.string().max(100).nullable().optional(),
  body:     z.string().min(1),
});

cannedResponses.get('/', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');

  const { data, error } = await sb
    .from('canned_responses')
    .select('id, display_id, name, category, body, created_at, updated_at')
    .eq('workspace_id', workspaceId)
    .order('display_id', { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ canned_responses: data });
});

cannedResponses.post('/', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = TemplateBody.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  const { data, error } = await sb
    .from('canned_responses')
    .insert({
      workspace_id: workspaceId,
      display_id:   nextDisplayId(),
      name:         input.name,
      category:     input.category ?? null,
      body:         input.body,
    })
    .select('id, display_id, name, category, body, created_at, updated_at')
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ canned_response: data }, 201);
});

const PatchTemplate = z.object({
  name:     z.string().min(1).max(200).optional(),
  category: z.string().max(100).nullable().optional(),
  body:     z.string().min(1).optional(),
}).strict();

cannedResponses.patch('/:id', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PatchTemplate.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  const { data, error } = await sb
    .from('canned_responses')
    .update(parsed.data)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select('id, display_id, name, category, body, updated_at')
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data)  return c.json({ error: 'Canned response not found' }, 404);
  return c.json({ canned_response: data });
});

cannedResponses.delete('/:id', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const { error } = await sb
    .from('canned_responses')
    .delete()
    .eq('id', id)
    .eq('workspace_id', workspaceId);
  if (error) return c.json({ error: error.message }, 500);
  return new Response(null, { status: 204 });
});
