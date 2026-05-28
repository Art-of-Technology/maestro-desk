import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';

export const ticketTemplates = new Hono();

ticketTemplates.use('*', requireAuth);

function nextDisplayId(): string {
  return `TT-${String(Math.floor(Math.random() * 9000 + 1000))}`;
}

const TemplateBody = z.object({
  name:         z.string().min(1).max(200),
  category:     z.string().max(100).nullable().optional(),
  priority_key: z.enum(['urgent', 'high', 'normal', 'low']).nullable().optional(),
  subject:      z.string().max(500).nullable().optional(),
  body:         z.string().nullable().optional(),
});

ticketTemplates.get('/', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');

  const { data, error } = await sb
    .from('ticket_templates')
    .select('id, display_id, name, category, priority_key, subject, body, created_at, updated_at')
    .eq('workspace_id', workspaceId)
    .order('display_id', { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ticket_templates: data });
});

ticketTemplates.post('/', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = TemplateBody.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  const { data, error } = await sb
    .from('ticket_templates')
    .insert({
      workspace_id: workspaceId,
      display_id:   nextDisplayId(),
      name:         input.name,
      category:     input.category ?? null,
      priority_key: input.priority_key ?? null,
      subject:      input.subject ?? null,
      body:         input.body ?? null,
    })
    .select('id, display_id, name, category, priority_key, subject, body, created_at, updated_at')
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ticket_template: data }, 201);
});

const PatchTemplate = z.object({
  name:         z.string().min(1).max(200).optional(),
  category:     z.string().max(100).nullable().optional(),
  priority_key: z.enum(['urgent', 'high', 'normal', 'low']).nullable().optional(),
  subject:      z.string().max(500).nullable().optional(),
  body:         z.string().nullable().optional(),
}).strict();

ticketTemplates.patch('/:id', async (c) => {
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
    .from('ticket_templates')
    .update(parsed.data)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select('id, display_id, name, category, priority_key, subject, body, updated_at')
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data)  return c.json({ error: 'Ticket template not found' }, 404);
  return c.json({ ticket_template: data });
});

ticketTemplates.delete('/:id', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const { error } = await sb
    .from('ticket_templates')
    .delete()
    .eq('id', id)
    .eq('workspace_id', workspaceId);
  if (error) return c.json({ error: error.message }, 500);
  return new Response(null, { status: 204 });
});
