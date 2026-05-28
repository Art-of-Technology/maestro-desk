import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';

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
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');

  const { data, error } = await sb
    .from('assign_rules')
    .select('id, display_id, name, priority, status, conditions, assignment, match_count, last_match_at, created_at, updated_at')
    .eq('workspace_id', workspaceId)
    .order('priority', { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ assign_rules: data });
});

assignRules.post('/', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = RuleBody.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  const { data, error } = await sb
    .from('assign_rules')
    .insert({
      workspace_id: workspaceId,
      display_id:   nextDisplayId(),
      name:         input.name,
      priority:     input.priority,
      status:       input.status ?? 'active',
      conditions:   input.conditions,
      assignment:   input.assignment,
    })
    .select('id, display_id, name, priority, status, conditions, assignment, match_count, last_match_at, created_at, updated_at')
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ assign_rule: data }, 201);
});

const PatchRule = z.object({
  name:        z.string().min(1).max(200).optional(),
  priority:    z.number().int().min(1).max(999).optional(),
  status:      z.enum(['active', 'inactive']).optional(),
  conditions:  Conditions.optional(),
  assignment:  Assignment.optional(),
}).strict();

assignRules.patch('/:id', async (c) => {
  const sb = c.get('sb');
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

  const { data, error } = await sb
    .from('assign_rules')
    .update(parsed.data)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select('id, display_id, name, priority, status, conditions, assignment, match_count, last_match_at, updated_at')
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data)  return c.json({ error: 'Assignment rule not found' }, 404);
  return c.json({ assign_rule: data });
});

assignRules.delete('/:id', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const { error } = await sb
    .from('assign_rules')
    .delete()
    .eq('id', id)
    .eq('workspace_id', workspaceId);
  if (error) return c.json({ error: error.message }, 500);
  return new Response(null, { status: 204 });
});
