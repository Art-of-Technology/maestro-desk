import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';
import { getDb } from '../lib/db.ts';

// Migration to Neon — Step 3. Member-level, workspace-scoped CRUD via getDb().
// conditions + assignment are jsonb (wrapped with sql.json on write).
export const assignRules = new Hono();

assignRules.use('*', requireAuth);

function nextDisplayId(): string {
  return `AR-${String(Math.floor(Math.random() * 9000 + 1000))}`;
}

const Conditions = z.object({
  priority: z.string(),
  category: z.string(),
  vip:      z.string(),
}).passthrough();

const SpecificAgent = z.object({
  mode:          z.literal('specific-agent'),
  agent_user_id: z.string().uuid(),
});
const TeamAssignment = z.object({
  mode:           z.enum(['round-robin', 'least-busy']),
  team_user_ids:  z.array(z.string().uuid()).min(1),
  rr_index:       z.number().int().optional(),
});
const Assignment = z.union([SpecificAgent, TeamAssignment]);

const RuleBody = z.object({
  name:        z.string().min(1).max(200),
  priority:    z.number().int().min(1).max(999),
  status:      z.enum(['active', 'inactive']).optional(),
  conditions:  Conditions,
  assignment:  Assignment,
});

assignRules.get('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const rows = await sql`
    select id, display_id, name, priority, status, conditions, assignment, match_count, last_match_at, created_at, updated_at
    from assign_rules
    where workspace_id = ${workspaceId}
    order by priority asc
  `;
  return c.json({ assign_rules: rows });
});

assignRules.post('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = RuleBody.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  try {
    const [row] = await sql`
      insert into assign_rules (workspace_id, display_id, name, priority, status, conditions, assignment)
      values (${workspaceId}, ${nextDisplayId()}, ${input.name}, ${input.priority},
              ${input.status ?? 'active'}, ${sql.json(input.conditions as any)}, ${sql.json(input.assignment as any)})
      returning id, display_id, name, priority, status, conditions, assignment, match_count, last_match_at, created_at, updated_at
    `;
    return c.json({ assign_rule: row }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

const PatchRule = z.object({
  name:        z.string().min(1).max(200).optional(),
  priority:    z.number().int().min(1).max(999).optional(),
  status:      z.enum(['active', 'inactive']).optional(),
  conditions:  Conditions.optional(),
  assignment:  Assignment.optional(),
}).strict();

assignRules.patch('/:id', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PatchRule.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  // jsonb fields must be JSON-wrapped; build the SET from present keys.
  const sets = [];
  if (parsed.data.name       !== undefined) sets.push(sql`name = ${parsed.data.name}`);
  if (parsed.data.priority   !== undefined) sets.push(sql`priority = ${parsed.data.priority}`);
  if (parsed.data.status     !== undefined) sets.push(sql`status = ${parsed.data.status}`);
  if (parsed.data.conditions !== undefined) sets.push(sql`conditions = ${sql.json(parsed.data.conditions as any)}`);
  if (parsed.data.assignment !== undefined) sets.push(sql`assignment = ${sql.json(parsed.data.assignment as any)}`);

  const [row] = await sql`
    update assign_rules set ${sets.reduce((acc, s, i) => (i ? sql`${acc}, ${s}` : s))}
    where id = ${id} and workspace_id = ${workspaceId}
    returning id, display_id, name, priority, status, conditions, assignment, match_count, last_match_at, updated_at
  `;
  if (!row) return c.json({ error: 'Assignment rule not found' }, 404);
  return c.json({ assign_rule: row });
});

assignRules.delete('/:id', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  await sql`delete from assign_rules where id = ${id} and workspace_id = ${workspaceId}`;
  return new Response(null, { status: 204 });
});
