import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';
import { getDb } from '../lib/db.ts';

// Migration to Neon — Step 3. Member-level, workspace-scoped CRUD via getDb().
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
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const rows = await sql`
    select id, display_id, name, category, priority_key, subject, body, created_at, updated_at
    from ticket_templates
    where workspace_id = ${workspaceId}
    order by display_id asc
  `;
  return c.json({ ticket_templates: rows });
});

ticketTemplates.post('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = TemplateBody.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  const [row] = await sql`
    insert into ticket_templates (workspace_id, display_id, name, category, priority_key, subject, body)
    values (${workspaceId}, ${nextDisplayId()}, ${input.name}, ${input.category ?? null},
            ${input.priority_key ?? null}, ${input.subject ?? null}, ${input.body ?? null})
    returning id, display_id, name, category, priority_key, subject, body, created_at, updated_at
  `;
  return c.json({ ticket_template: row }, 201);
});

const PatchTemplate = z.object({
  name:         z.string().min(1).max(200).optional(),
  category:     z.string().max(100).nullable().optional(),
  priority_key: z.enum(['urgent', 'high', 'normal', 'low']).nullable().optional(),
  subject:      z.string().max(500).nullable().optional(),
  body:         z.string().nullable().optional(),
}).strict();

ticketTemplates.patch('/:id', async (c) => {
  const sql = getDb();
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

  const [row] = await sql`
    update ticket_templates set ${sql(parsed.data)}
    where id = ${id} and workspace_id = ${workspaceId}
    returning id, display_id, name, category, priority_key, subject, body, updated_at
  `;
  if (!row) return c.json({ error: 'Ticket template not found' }, 404);
  return c.json({ ticket_template: row });
});

ticketTemplates.delete('/:id', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  await sql`delete from ticket_templates where id = ${id} and workspace_id = ${workspaceId}`;
  return new Response(null, { status: 204 });
});
