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

  const { data, error } = await sb
    .from('kb_articles')
    .select(`
      id, display_id, title, category, body, author_user_id, status,
      view_count, helpful_count, unhelpful_count, created_at, updated_at,
      users(name)
    `)
    .eq('workspace_id', workspaceId)
    .order('updated_at', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);

  const articles = (data || []).map((r: any) => ({
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
