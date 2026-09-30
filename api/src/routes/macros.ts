import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspaceAdmin } from '../lib/authz.js';
import { getDb } from '../lib/db.js';

export const macros = new Hono();
macros.use('*', requireAuth);
const Action = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('status'), value: z.enum(['open', 'pending', 'escalated', 'gdpr', 'resolved']) }).strict(),
  z.object({ kind: z.literal('priority'), value: z.enum(['urgent', 'high', 'normal', 'low']) }).strict(),
  z.object({ kind: z.literal('assign'), value: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('tag'), value: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/) }).strict(),
  z.object({ kind: z.literal('reply'), templateId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('note'), text: z.string().trim().min(1).max(10000) }).strict(),
]);
const Body = z.object({
  name: z.string().trim().min(1).max(200),
  icon: z.string().max(16).default('⚡'),
  description: z.string().max(1000).default(''),
  actions: z.array(Action).min(1).max(30),
}).strict();
const columns = 'id, display_id, name, icon, description, actions, usage_count, last_used_at';

macros.get('/', async (c) => {
  const sql = getDb();
  const rows = await sql`select ${sql.unsafe(columns)} from workspace_macros
    where workspace_id = ${c.get('workspaceId')} and deleted_at is null order by created_at desc`;
  return c.json({ macros: rows });
});

// UUID references stay valid when a template is renamed. Validate every
// reference against the active workspace, including a platform admin's writes.
async function referencesExist(workspaceId: string, actions: z.infer<typeof Action>[]) {
  const sql = getDb();
  const ids = [...new Set(actions.filter(a => a.kind === 'reply').map(a => a.templateId))];
  if (!ids.length) return true;
  const rows = await sql`select id from canned_responses where workspace_id = ${workspaceId} and id in ${sql(ids)}`;
  return rows.length === ids.length;
}

macros.post('/', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;
  const parsed = Body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid macro', issues: parsed.error.issues }, 400);
  const sql = getDb(), d = parsed.data, ws = c.get('workspaceId');
  if (!await referencesExist(ws, d.actions)) return c.json({ error: 'A reply template is unavailable in this workspace.' }, 400);
  const [row] = await sql`insert into workspace_macros (workspace_id, name, icon, description, actions)
    values (${ws}, ${d.name}, ${d.icon}, ${d.description}, ${sql.json(d.actions)}) returning ${sql.unsafe(columns)}`;
  return c.json({ macro: row }, 201);
});

macros.put('/:id', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;
  if (!z.string().uuid().safeParse(c.req.param('id')).success) return c.json({ error: 'Invalid macro ID' }, 400);
  const parsed = Body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid macro', issues: parsed.error.issues }, 400);
  const sql = getDb(), d = parsed.data, ws = c.get('workspaceId');
  const [existing] = await sql`select id from workspace_macros
    where id=${c.req.param('id')} and workspace_id=${ws} and deleted_at is null`;
  if (!existing) return c.json({ error: 'Macro not found' }, 404);
  if (!await referencesExist(ws, d.actions)) return c.json({ error: 'A reply template is unavailable in this workspace.' }, 400);
  const [row] = await sql`update workspace_macros set name=${d.name}, icon=${d.icon}, description=${d.description},
    actions=${sql.json(d.actions)}, updated_at=now()
    where id=${c.req.param('id')} and workspace_id=${ws} and deleted_at is null returning ${sql.unsafe(columns)}`;
  return row ? c.json({ macro: row }) : c.json({ error: 'Macro not found' }, 404);
});

macros.delete('/:id', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;
  if (!z.string().uuid().safeParse(c.req.param('id')).success) return c.json({ error: 'Invalid macro ID' }, 400);
  const sql = getDb();
  const [row] = await sql`update workspace_macros set deleted_at=now(), updated_at=now()
    where id=${c.req.param('id')} and workspace_id=${c.get('workspaceId')} and deleted_at is null returning id`;
  return row ? c.json({ ok: true }) : c.json({ error: 'Macro not found' }, 404);
});

macros.post('/:id/use', async (c) => {
  if (!z.string().uuid().safeParse(c.req.param('id')).success) return c.json({ error: 'Invalid macro ID' }, 400);
  const sql = getDb();
  const [row] = await sql`update workspace_macros set usage_count=usage_count+1, last_used_at=now()
    where id=${c.req.param('id')} and workspace_id=${c.get('workspaceId')} and deleted_at is null
    returning usage_count, last_used_at`;
  return row ? c.json({ macro: row }) : c.json({ error: 'Macro not found' }, 404);
});
