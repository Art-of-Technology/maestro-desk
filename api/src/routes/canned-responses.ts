import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../lib/db.js';
import { requireWorkspaceAdmin } from '../lib/authz.js';
import { templateBody } from '../lib/template-body.js';
import { MAX_HTML_CHARS } from '../lib/html-text.js';

// Migration to Neon — Step 3. Member-level, workspace-scoped CRUD via getDb()
// raw SQL. Membership is verified by the auth middleware; every query scopes
// to the active workspace_id (the authz the RLS member policy provided).
export const cannedResponses = new Hono();

cannedResponses.use('*', requireAuth);

function nextDisplayId(): string {
  return `TPL-${String(Math.floor(Math.random() * 9000 + 1000))}`;
}

const TemplateBody = z.object({
  name:     z.string().min(1).max(200),
  category: z.string().max(100).nullable().optional(),
  body:     z.string().max(MAX_HTML_CHARS),
  body_html: z.string().max(MAX_HTML_CHARS).nullable().optional(),
}).strict();

cannedResponses.get('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const rows = await sql`
    select id, display_id, name, category, body, body_html, created_at, updated_at
    from canned_responses
    where workspace_id = ${workspaceId}
    order by display_id asc
  `;
  return c.json({ canned_responses: rows });
});

cannedResponses.post('/', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;
  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = TemplateBody.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;
  const content = templateBody(input.body, input.body_html);
  if (!content.body.trim()) return c.json({ error: 'Template body is empty' }, 400);

  const [row] = await sql`
    insert into canned_responses (workspace_id, display_id, name, category, body, body_html)
    values (${workspaceId}, ${nextDisplayId()}, ${input.name}, ${input.category ?? null}, ${content.body}, ${content.body_html})
    returning id, display_id, name, category, body, body_html, created_at, updated_at
  `;
  return c.json({ canned_response: row }, 201);
});

const PatchTemplate = z.object({
  name:     z.string().min(1).max(200).optional(),
  category: z.string().max(100).nullable().optional(),
  body:     z.string().max(MAX_HTML_CHARS).optional(),
  body_html: z.string().max(MAX_HTML_CHARS).nullable().optional(),
}).strict();

cannedResponses.patch('/:id', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;
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

  if ('body_html' in parsed.data && !('body' in parsed.data)) {
    return c.json({ error: 'Include the plain body when updating HTML' }, 400);
  }
  const update = { ...parsed.data };
  if (update.body !== undefined) {
    Object.assign(update, templateBody(update.body, update.body_html));
    if (!update.body.trim()) return c.json({ error: 'Template body is empty' }, 400);
  }
  const [row] = await sql`
    update canned_responses set ${sql(update)}
    where id = ${id} and workspace_id = ${workspaceId}
    returning id, display_id, name, category, body, body_html, updated_at
  `;
  if (!row) return c.json({ error: 'Canned response not found' }, 404);
  return c.json({ canned_response: row });
});

cannedResponses.delete('/:id', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  await sql`delete from canned_responses where id = ${id} and workspace_id = ${workspaceId}`;
  return new Response(null, { status: 204 });
});
