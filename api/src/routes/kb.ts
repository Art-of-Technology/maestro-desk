import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';
import { getDb } from '../lib/db.ts';

// Migration to Neon — Step 3. Member-level, workspace-scoped via getDb().
export const kb = new Hono();

kb.use('*', requireAuth);

function nextDisplayId(): string {
  return `KB-${String(Math.floor(Math.random() * 9000 + 1000))}`;
}

const KbBody = z.object({
  title:    z.string().min(1).max(300),
  category: z.string().min(1).max(100),
  body:     z.string().min(1),
  status:   z.enum(['draft', 'published', 'archived']).optional(),
});

// ─── GET / — list (author name + this user's vote, in one join query) ─────
kb.get('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');

  const articles = await sql`
    select a.id, a.display_id, a.title, a.category, a.body, a.author_user_id, a.status,
           a.view_count, a.helpful_count, a.unhelpful_count, a.created_at, a.updated_at,
           u.name as author_name,
           coalesce(v.vote, 0) as my_vote   -- 1 = up, -1 = down, 0 = none
    from kb_articles a
    left join users u on u.id = a.author_user_id
    left join kb_votes v on v.article_id = a.id and v.user_key = ${userId} and v.workspace_id = ${workspaceId}
    where a.workspace_id = ${workspaceId}
    order by a.updated_at desc
  `;
  return c.json({ articles });
});

// ─── POST / — create ──────────────────────────────────────────────────────
kb.post('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = KbBody.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  // CTE so we can return the joined author name in one round-trip.
  const [article] = await sql`
    with ins as (
      insert into kb_articles (workspace_id, display_id, title, category, body, author_user_id, status)
      values (${workspaceId}, ${nextDisplayId()}, ${input.title}, ${input.category}, ${input.body},
              ${userId}, ${input.status ?? 'published'})
      returning *
    )
    select ins.id, ins.display_id, ins.title, ins.category, ins.body, ins.author_user_id, ins.status,
           ins.view_count, ins.helpful_count, ins.unhelpful_count, ins.created_at, ins.updated_at,
           u.name as author_name
    from ins left join users u on u.id = ins.author_user_id
  `;
  return c.json({ article }, 201);
});

// ─── PATCH /:id — edit ────────────────────────────────────────────────────
const PatchKb = z.object({
  title:    z.string().min(1).max(300).optional(),
  category: z.string().min(1).max(100).optional(),
  body:     z.string().min(1).optional(),
  status:   z.enum(['draft', 'published', 'archived']).optional(),
}).strict();

kb.patch('/:id', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PatchKb.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  const [article] = await sql`
    with upd as (
      update kb_articles set ${sql(parsed.data)}
      where id = ${id} and workspace_id = ${workspaceId}
      returning *
    )
    select upd.id, upd.display_id, upd.title, upd.category, upd.body, upd.status, upd.updated_at,
           u.name as author_name
    from upd left join users u on u.id = upd.author_user_id
  `;
  if (!article) return c.json({ error: 'Article not found' }, 404);
  return c.json({ article });
});

// ─── DELETE /:id ─────────────────────────────────────────────────────────
kb.delete('/:id', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  await sql`delete from kb_articles where id = ${id} and workspace_id = ${workspaceId}`;
  return new Response(null, { status: 204 });
});

// ─── POST /:id/view — increment view_count (atomic) ──────────────────────
kb.post('/:id/view', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const [row] = await sql`
    update kb_articles set view_count = view_count + 1
    where id = ${id} and workspace_id = ${workspaceId}
    returning view_count
  `;
  if (!row) return c.json({ error: 'Article not found' }, 404);
  return c.json({ view_count: row.view_count });
});

// ─── POST /:id/vote { direction } — upsert / clear this user's vote ───────
// direction: 'up' → vote=1, 'down' → vote=-1, 'clear' → remove. Maintains
// helpful_count / unhelpful_count by rolling back the prior vote and applying
// the new one (counters floored at 0).
const PostVote = z.object({
  direction: z.enum(['up', 'down', 'clear']),
});

kb.post('/:id/vote', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const id = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PostVote.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const direction = parsed.data.direction;

  const nextVote = direction === 'up' ? 1 : direction === 'down' ? -1 : 0;

  // Run the read-modify-write inside a transaction that locks the article row
  // (SELECT … FOR UPDATE), so concurrent votes on the same article serialize
  // and the helpful/unhelpful counters can't race. Returns null if the
  // article isn't in this workspace.
  const result = await sql.begin(async (tx) => {
    const [art] = await tx`
      select helpful_count, unhelpful_count from kb_articles
      where id = ${id} and workspace_id = ${workspaceId}
      for update
    `;
    if (!art) return null;

    const [vrow] = await tx`
      select vote from kb_votes
      where article_id = ${id} and user_key = ${userId} and workspace_id = ${workspaceId}
    `;
    const prev = (vrow?.vote ?? 0) as number;
    let helpful   = art.helpful_count   || 0;
    let unhelpful = art.unhelpful_count || 0;
    if (prev ===  1) helpful--;
    if (prev === -1) unhelpful--;
    if (nextVote ===  1) helpful++;
    if (nextVote === -1) unhelpful++;
    helpful = Math.max(0, helpful);     // floor at 0 — defends against drift
    unhelpful = Math.max(0, unhelpful);

    if (nextVote === 0) {
      if (prev !== 0) {
        await tx`delete from kb_votes where workspace_id = ${workspaceId} and article_id = ${id} and user_key = ${userId}`;
      }
    } else {
      await tx`
        insert into kb_votes (workspace_id, article_id, user_key, vote)
        values (${workspaceId}, ${id}, ${userId}, ${nextVote})
        on conflict (article_id, user_key) do update set vote = excluded.vote
      `;
    }
    await tx`
      update kb_articles set helpful_count = ${helpful}, unhelpful_count = ${unhelpful}
      where id = ${id} and workspace_id = ${workspaceId}
    `;
    return { my_vote: nextVote, helpful_count: helpful, unhelpful_count: unhelpful };
  });

  if (!result) return c.json({ error: 'Article not found' }, 404);
  return c.json(result);
});
