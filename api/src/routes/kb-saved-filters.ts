import type { TransactionSql } from 'postgres';
import { Hono } from 'hono';
import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../lib/db.js';

export const kbSavedFilters = new Hono();
kbSavedFilters.use('*', requireAuth);
const Filters = z.object({
  category: z.string().max(200), market: z.string().max(50),
  status: z.enum(['all', 'draft', 'published', 'archived']), query: z.string().max(500),
}).strict();
const Name = z.string().trim().min(1).max(60);
const Create = z.object({name: Name, filters: Filters}).strict();
const Transfer = z.object({items: z.array(Create.extend({id: z.string().min(1).max(100)})).max(25)}).strict();

// Serialize all writes for this owner, including imports and deletes. This makes
// the 25-filter cap safe under concurrent requests from different devices.
async function write<T>(workspace: string, user: string, fn: (sql: TransactionSql) => Promise<T>): Promise<T> {
  try {
    return await getDb().begin(async sql => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['kb-filters', workspace, user])}, 0))`;
      return await fn(sql);
    }) as T;
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if ((error as {code?: string}).code === '23505')
      throw new HTTPException(409, {message: 'A saved filter already has that name. Choose another name.'});
    console.error('[kb-saved-filters] write failed', (error as {code?: string}).code || 'unknown');
    throw new HTTPException(500, {message: 'Could not save the filter change. Try again.'});
  }
}
async function room(sql: TransactionSql, workspace: string, user: string) {
  const [row] = await sql`select count(*)::int as count from kb_saved_filters where workspace_id=${workspace} and user_id=${user}`;
  if (row.count >= 25) throw new HTTPException(409, {message: 'You can save up to 25 filters. Delete one before adding another.'});
}
kbSavedFilters.get('/', async c => {
  const sql = getDb(), workspace = c.get('workspaceId'), user = c.get('userId');
  const items = await sql`select id,name,filters,is_pinned from kb_saved_filters where workspace_id=${workspace} and user_id=${user} order by created_at,id`;
  return c.json({items});
});
kbSavedFilters.post('/', async c => {
  const parsed = Create.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({error: 'Enter a name of 1–60 characters and valid filter criteria.'}, 400);
  const workspace = c.get('workspaceId'), user = c.get('userId');
  const item = await write(workspace, user, async sql => {
    await room(sql, workspace, user);
    const [row] = await sql`insert into kb_saved_filters(workspace_id,user_id,name,filters)
      values(${workspace},${user},${parsed.data.name},${sql.json(parsed.data.filters)}) returning id,name,filters,is_pinned`;
    return row;
  });
  return c.json({item}, 201);
});
kbSavedFilters.post('/import', async c => {
  const parsed = Transfer.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({error: 'These browser filters could not be transferred.'}, 400);
  const workspace = c.get('workspaceId'), user = c.get('userId');
  const transferred = await write(workspace, user, async sql => {
    const accepted: string[] = [];
    for (const item of parsed.data.items) {
      const payload = {name:item.name,filters:item.filters};
      const [receipt] = await sql`select source_payload=${sql.json(payload)}::jsonb as matches from kb_filter_transfers where workspace_id=${workspace} and user_id=${user} and source_id=${item.id}`;
      if (receipt) {
        if (receipt.matches) accepted.push(item.id);
        continue;
      }
      await room(sql, workspace, user);
      // Preserve both filters when two browsers used the same name.
      let name = item.name, suffix = 1;
      while ((await sql`select 1 from kb_saved_filters where workspace_id=${workspace} and user_id=${user} and lower(name)=lower(${name})`).length) {
        const tail = ` (imported ${suffix++})`;
        name = item.name.slice(0, 60 - tail.length) + tail;
      }
      await sql`insert into kb_saved_filters(workspace_id,user_id,name,filters) values(${workspace},${user},${name},${sql.json(item.filters)})`;
      await sql`insert into kb_filter_transfers(workspace_id,user_id,source_id,source_payload) values(${workspace},${user},${item.id},${sql.json(payload)})`;
      accepted.push(item.id);
    }
    return accepted;
  });
  return c.json({transferred});
});
kbSavedFilters.patch('/:id', async c => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  const parsed = z.object({name: Name.optional(), is_pinned: z.boolean().optional()}).strict().safeParse(await c.req.json().catch(() => null));
  if (!id.success || !parsed.success) return c.json({error: 'Enter a valid filter name, pin preference and filter ID.'}, 400);
  if (!Object.keys(parsed.data).length) return c.json({error: 'No filter changes supplied.'}, 400);
  const workspace = c.get('workspaceId'), user = c.get('userId');
  const item = await write(workspace, user, async sql => {
    const [row] = await sql`update kb_saved_filters set ${sql(parsed.data)} where id=${id.data} and workspace_id=${workspace} and user_id=${user} returning id,name,filters,is_pinned`;
    if (!row) throw new HTTPException(404, {message: 'This saved filter no longer exists. Refresh the list.'});
    return row;
  });
  return c.json({item});
});
kbSavedFilters.delete('/:id', async c => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({error: 'Invalid filter ID.'}, 400);
  const workspace = c.get('workspaceId'), user = c.get('userId');
  await write(workspace, user, async sql => {
    await sql`delete from kb_saved_filters where id=${id.data} and workspace_id=${workspace} and user_id=${user}`;
  });
  return c.body(null, 204);
});
