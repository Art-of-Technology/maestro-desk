import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../lib/db.js';

export const activity = new Hono();
activity.use('*', requireAuth);
const Query = z.object({
  kind: z.enum(['all', 'status', 'priority', 'agent', 'tag', 'note', 'created', 'system']).default('all'),
  entity: z.enum(['all', 'ticket', 'customer']).default('all'),
  q: z.string().max(200).default(''),
  ticket: z.string().uuid().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const Cursor = z.object({ at: z.string().max(50).refine(v => Number.isFinite(Date.parse(v))), id: z.string().uuid() });

activity.get('/', async c => {
  const parsed = Query.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: 'Invalid activity filters' }, 400);
  const { kind, entity, q, ticket, limit, cursor } = parsed.data;
  let before: z.infer<typeof Cursor> | undefined;
  if (cursor) {
    try { before = Cursor.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString())); }
    catch { return c.json({ error: 'Invalid activity cursor' }, 400); }
  }
  const sql = getDb(), ws = c.get('workspaceId');
  // Read persisted sources, including creations and customer notes that the
  // old page inferred from its partially loaded browser lists.
  const rows = await sql`with feed as (
    select e.id, e.created_at, e.kind, e.author_label, e.details, 'ticket' as entity,
      t.id as entity_uuid, t.display_id as entity_id, t.subject as entity_name
    from events e join tickets t on t.id = e.entity_id and t.workspace_id = e.workspace_id
    where e.workspace_id = ${ws} and e.entity_type = 'ticket' and t.deleted_at is null
    union all
    select t.id, t.created_at, 'created', 'System', 'Ticket created', 'ticket', t.id, t.display_id, t.subject
    from tickets t where t.workspace_id = ${ws} and t.deleted_at is null
    union all
    select n.id, n.created_at, 'note', coalesce(u.name, 'Former agent'), 'Internal note: ' || n.text,
      'customer', cu.id, cu.display_id, concat_ws(' ', cu.first_name, cu.last_name)
    from customer_notes n join customers cu on cu.id = n.customer_id and cu.workspace_id = n.workspace_id
    left join users u on u.id = n.author_user_id
    where n.workspace_id = ${ws} and n.deleted_at is null and cu.deleted_at is null
  ) select id, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
      kind, author_label, details, entity, entity_uuid, entity_id, entity_name
    from feed where (${kind} = 'all' or kind = ${kind}) and (${entity} = 'all' or entity = ${entity})
    ${ticket ? sql`and entity = 'ticket' and entity_uuid = ${ticket}` : sql``}
    and (${q} = '' or strpos(lower(concat_ws(' ', details, author_label, entity_id, entity_name)), lower(${q})) > 0)
    ${before ? sql`and (created_at, id) < (${before.at}::timestamptz, ${before.id}::uuid)` : sql``}
    order by feed.created_at desc, id desc limit ${limit + 1}`;
  const more = rows.length > limit, events = rows.slice(0, limit), last = events.at(-1);
  return c.json({ events, next_cursor: more && last
    ? Buffer.from(JSON.stringify({ at: last.created_at, id: last.id })).toString('base64url') : null });
});
