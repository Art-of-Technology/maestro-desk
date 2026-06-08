import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';
import { getDb } from '../lib/db.ts';

// Migration to Neon — Step 3. Member-level, workspace-scoped CRUD via getDb().
export const slaPolicies = new Hono();

slaPolicies.use('*', requireAuth);

function nextDisplayId(): string {
  return `SLA-${String(Math.floor(Math.random() * 9000 + 1000))}`;
}

// category_key is nullable for "any category" — the SPA models this as 'all';
// the API uses null. Translation happens client-side.
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
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const rows = await sql`
    select id, display_id, name, priority_key, category_key, first_response_min, resolution_min, status, created_at, updated_at
    from sla_policies
    where workspace_id = ${workspaceId}
    order by display_id asc
  `;
  return c.json({ sla_policies: rows });
});

slaPolicies.post('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PolicyBody.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  const [row] = await sql`
    insert into sla_policies
      (workspace_id, display_id, name, priority_key, category_key, first_response_min, resolution_min, status)
    values
      (${workspaceId}, ${nextDisplayId()}, ${input.name}, ${input.priority_key}, ${input.category_key ?? null},
       ${input.first_response_min}, ${input.resolution_min}, ${input.status ?? 'active'})
    returning id, display_id, name, priority_key, category_key, first_response_min, resolution_min, status, created_at, updated_at
  `;
  return c.json({ sla_policy: row }, 201);
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
  const sql = getDb();
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

  // Cross-field validation: if either min is touched, the result must still
  // satisfy resolution_min >= first_response_min. Pull the current row to
  // check the un-touched side.
  if (parsed.data.first_response_min !== undefined || parsed.data.resolution_min !== undefined) {
    const [current] = await sql`
      select first_response_min, resolution_min from sla_policies
      where id = ${id} and workspace_id = ${workspaceId}
    `;
    if (!current) return c.json({ error: 'SLA policy not found' }, 404);
    const nextFirst = parsed.data.first_response_min ?? current.first_response_min;
    const nextRes   = parsed.data.resolution_min     ?? current.resolution_min;
    if (nextRes < nextFirst) {
      return c.json({ error: 'resolution_min must be at least first_response_min' }, 400);
    }
  }

  const [row] = await sql`
    update sla_policies set ${sql(parsed.data)}
    where id = ${id} and workspace_id = ${workspaceId}
    returning id, display_id, name, priority_key, category_key, first_response_min, resolution_min, status, updated_at
  `;
  if (!row) return c.json({ error: 'SLA policy not found' }, 404);
  return c.json({ sla_policy: row });
});

slaPolicies.delete('/:id', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  await sql`delete from sla_policies where id = ${id} and workspace_id = ${workspaceId}`;
  return new Response(null, { status: 204 });
});
