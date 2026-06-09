import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';
import { getDb } from '../lib/db.ts';

export const savedSearches = new Hono();

savedSearches.use('*', requireAuth);

// Migration to Neon — Step 3. Data access is raw SQL on Neon via getDb().
//
// Authz parity with the RLS policies this replaces (no RLS on Neon):
//   - READ: a member sees their OWN rows plus any SHARED row, scoped to the
//     active workspace → WHERE workspace_id = ws AND (user_id = me OR is_shared)
//   - WRITE (update/delete): OWNER only, scoped to workspace → the WHERE
//     clause adds user_id = me AND workspace_id = ws. (Previously the route
//     trusted the saved_searches_owner_write policy to gate `where id = :id`.)
// userId / workspaceId come from the auth middleware (Better Auth session).

// Filters JSON. Loosely typed so the UI can add filter dimensions without a
// schema bump; .strict() rejects unknown keys.
const Filters = z.object({
  status:    z.string().max(40).optional(),
  category:  z.string().max(80).optional(),
  priority:  z.string().max(40).optional(),
  agent:     z.string().max(120).optional(),
  sentiment: z.string().max(40).optional(),
  view:      z.string().max(40).optional(),
  query:     z.string().max(200).optional(),
}).strict();

const CreateBody = z.object({
  name:      z.string().min(1).max(100),
  filters:   Filters,
  is_shared: z.boolean().optional(),
  is_pinned: z.boolean().optional(),
});

const PatchBody = z.object({
  name:      z.string().min(1).max(100).optional(),
  filters:   Filters.optional(),
  is_shared: z.boolean().optional(),
  is_pinned: z.boolean().optional(),
}).strict();

savedSearches.get('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId      = c.get('userId');

  // Own rows (any is_shared) + every shared row, scoped to the workspace.
  // Left-join users for the owner attribution string used on shared entries.
  const rows = await sql`
    select ss.id, ss.user_id, ss.name, ss.filters, ss.is_shared, ss.is_pinned,
           ss.created_at, ss.updated_at, u.name as owner_name
    from saved_searches ss
    left join users u on u.id = ss.user_id
    where ss.workspace_id = ${workspaceId}
      and (ss.user_id = ${userId} or ss.is_shared = true)
    order by ss.is_shared asc, ss.created_at desc
  `;
  return c.json({ saved_searches: rows });
});

savedSearches.post('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId      = c.get('userId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = CreateBody.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);

  try {
    const [row] = await sql`
      insert into saved_searches (workspace_id, user_id, name, filters, is_shared, is_pinned)
      values (${workspaceId}, ${userId}, ${parsed.data.name}, ${sql.json(parsed.data.filters)},
              ${parsed.data.is_shared ?? false}, ${parsed.data.is_pinned ?? false})
      returning id, user_id, name, filters, is_shared, is_pinned, created_at, updated_at
    `;
    return c.json({ saved_search: row }, 201);
  } catch (err) {
    // Unique-violation on (workspace_id, user_id, lower(name)) → 409
    if ((err as any)?.code === '23505') {
      return c.json({ error: 'A saved search with that name already exists' }, 409);
    }
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

savedSearches.patch('/:id', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId      = c.get('userId');
  const id = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PatchBody.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: 'No fields to update' }, 400);

  try {
    // Owner-only, workspace-scoped — the authz gate RLS used to provide.
    // postgres.js encodes the `filters` object into the jsonb column.
    const [row] = await sql`
      update saved_searches set ${sql(parsed.data)}
      where id = ${id} and workspace_id = ${workspaceId} and user_id = ${userId}
      returning id, user_id, name, filters, is_shared, is_pinned, created_at, updated_at
    `;
    if (!row) return c.json({ error: 'Saved search not found' }, 404);
    return c.json({ saved_search: row });
  } catch (err) {
    if ((err as any)?.code === '23505') {
      return c.json({ error: 'A saved search with that name already exists' }, 409);
    }
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

savedSearches.delete('/:id', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId      = c.get('userId');
  const id = c.req.param('id');

  // Owner-only, workspace-scoped delete (idempotent — 204 whether or not a row
  // matched, but a non-owner can never delete someone else's search).
  await sql`
    delete from saved_searches
    where id = ${id} and workspace_id = ${workspaceId} and user_id = ${userId}
  `;
  return new Response(null, { status: 204 });
});
