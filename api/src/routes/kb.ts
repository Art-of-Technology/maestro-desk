import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';

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

// ─── GET / — list ─────────────────────────────────────────────────────────
//
// Joins users(name) so the SPA can render the author name without a
// second round-trip. view / helpful / unhelpful counts come along for
// the existing "popularity" pane.
kb.get('/', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');

  const [articlesRes, votesRes] = await Promise.all([
    sb.from('kb_articles')
      .select(`
        id, display_id, title, category, body, author_user_id, status,
        view_count, helpful_count, unhelpful_count, created_at, updated_at,
        users(name)
      `)
      .eq('workspace_id', workspaceId)
      .order('updated_at', { ascending: false }),
    // This user's vote on each article. user_key is the userId string —
    // matches what POST /:id/vote writes below.
    sb.from('kb_votes')
      .select('article_id, vote')
      .eq('workspace_id', workspaceId)
      .eq('user_key', userId),
  ]);
  if (articlesRes.error) return c.json({ error: articlesRes.error.message }, 500);
  if (votesRes.error)    return c.json({ error: votesRes.error.message }, 500);

  const myVotes: Record<string, number> = {};
  for (const v of votesRes.data || []) myVotes[v.article_id] = v.vote;

  const articles = (articlesRes.data || []).map((r: any) => ({
    id:              r.id,
    display_id:      r.display_id,
    title:           r.title,
    category:        r.category,
    body:            r.body,
    author_user_id:  r.author_user_id,
    author_name:     r.users?.name || null,
    status:          r.status,
    view_count:      r.view_count,
    helpful_count:   r.helpful_count,
    unhelpful_count: r.unhelpful_count,
    my_vote:         myVotes[r.id] ?? 0,  // 1 = up, -1 = down, 0 = no vote
    created_at:      r.created_at,
    updated_at:      r.updated_at,
  }));
  return c.json({ articles });
});

// ─── POST / — create ──────────────────────────────────────────────────────
kb.post('/', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = KbBody.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  const { data, error } = await sb
    .from('kb_articles')
    .insert({
      workspace_id:   workspaceId,
      display_id:     nextDisplayId(),
      title:          input.title,
      category:       input.category,
      body:           input.body,
      author_user_id: userId,
      status:         input.status ?? 'published',
    })
    .select(`
      id, display_id, title, category, body, author_user_id, status,
      view_count, helpful_count, unhelpful_count, created_at, updated_at,
      users(name)
    `)
    .single();
  if (error) return c.json({ error: error.message }, 500);

  const article = {
    ...data,
    author_name: (data as any).users?.name || null,
  };
  delete (article as any).users;
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
  const sb = c.get('sb');
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

  const { data, error } = await sb
    .from('kb_articles')
    .update(parsed.data)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select(`
      id, display_id, title, category, body, status, updated_at,
      users(name)
    `)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data)  return c.json({ error: 'Article not found' }, 404);

  const article = {
    ...data,
    author_name: (data as any).users?.name || null,
  };
  delete (article as any).users;
  return c.json({ article });
});

// ─── DELETE /:id ─────────────────────────────────────────────────────────
kb.delete('/:id', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const { error } = await sb
    .from('kb_articles')
    .delete()
    .eq('id', id)
    .eq('workspace_id', workspaceId);
  if (error) return c.json({ error: error.message }, 500);
  return new Response(null, { status: 204 });
});

// ─── POST /:id/view — increment view_count ──────────────────────────────
//
// Best-effort. Returns the new count so the SPA can mirror it without
// a re-fetch. No deduplication here — the SPA already debounces by
// only firing on detail-open, which is sufficient for v1.
kb.post('/:id/view', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  // Pull current count + increment + write back. Race-vulnerable in
  // theory (two concurrent opens could both read N and write N+1), but
  // KB views are an audit-trail counter, not a billing-sensitive one —
  // acceptable. Future fix: an atomic .rpc('increment_kb_view').
  const { data: row, error: lookupErr } = await sb
    .from('kb_articles')
    .select('id, view_count')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (lookupErr) return c.json({ error: lookupErr.message }, 500);
  if (!row) return c.json({ error: 'Article not found' }, 404);

  const next = (row.view_count || 0) + 1;
  const { error: updErr } = await sb
    .from('kb_articles')
    .update({ view_count: next })
    .eq('id', id)
    .eq('workspace_id', workspaceId);
  if (updErr) return c.json({ error: updErr.message }, 500);

  return c.json({ view_count: next });
});

// ─── POST /:id/vote { direction } — upsert / clear this user's vote ────
//
// direction:
//   'up'    → set vote=1; if user previously voted down, swap counters.
//   'down'  → set vote=-1; if user previously voted up, swap counters.
//   'clear' → delete kb_votes row + decrement the matching counter.
//
// kb_articles.helpful_count / unhelpful_count are maintained atomically
// (best-effort sequential — Supabase JS doesn't expose transactions,
// so the writes are ordered to minimise the damage if one fails: vote
// row first, counter second. Worst-case the counter drifts by ±1; the
// SPA can resync from the kb_votes aggregate on full reload).
const PostVote = z.object({
  direction: z.enum(['up', 'down', 'clear']),
});

kb.post('/:id/vote', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const id = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PostVote.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const direction = parsed.data.direction;

  // Fetch current article counts + this user's existing vote (if any).
  const [artRes, voteRes] = await Promise.all([
    sb.from('kb_articles')
      .select('id, helpful_count, unhelpful_count')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
    sb.from('kb_votes')
      .select('vote')
      .eq('article_id', id)
      .eq('user_key', userId)
      .maybeSingle(),
  ]);
  if (artRes.error)  return c.json({ error: artRes.error.message }, 500);
  if (voteRes.error) return c.json({ error: voteRes.error.message }, 500);
  if (!artRes.data)  return c.json({ error: 'Article not found' }, 404);

  const prev = voteRes.data?.vote ?? 0;  // 1, -1, or 0
  let helpful   = artRes.data.helpful_count   || 0;
  let unhelpful = artRes.data.unhelpful_count || 0;

  // Compute the counter delta + the next vote row state.
  let nextVote: number = 0;
  if (direction === 'up')    nextVote =  1;
  if (direction === 'down')  nextVote = -1;
  if (direction === 'clear') nextVote =  0;

  // Roll back the previous vote's contribution.
  if (prev ===  1) helpful--;
  if (prev === -1) unhelpful--;
  // Apply the new vote's contribution.
  if (nextVote ===  1) helpful++;
  if (nextVote === -1) unhelpful++;

  // Persist the vote row.
  if (nextVote === 0) {
    if (prev !== 0) {
      const { error: delErr } = await sb
        .from('kb_votes')
        .delete()
        .eq('article_id', id)
        .eq('user_key', userId);
      if (delErr) return c.json({ error: delErr.message }, 500);
    }
  } else {
    const { error: upErr } = await sb
      .from('kb_votes')
      .upsert(
        { workspace_id: workspaceId, article_id: id, user_key: userId, vote: nextVote },
        { onConflict: 'article_id,user_key' },
      );
    if (upErr) return c.json({ error: upErr.message }, 500);
  }

  // Persist the counter shifts. Floor at 0 — defense against pre-existing
  // counter drift; counters should never go negative.
  const { error: updErr } = await sb
    .from('kb_articles')
    .update({
      helpful_count:   Math.max(0, helpful),
      unhelpful_count: Math.max(0, unhelpful),
    })
    .eq('id', id)
    .eq('workspace_id', workspaceId);
  if (updErr) return c.json({ error: updErr.message }, 500);

  return c.json({
    my_vote:         nextVote,
    helpful_count:   Math.max(0, helpful),
    unhelpful_count: Math.max(0, unhelpful),
  });
});
