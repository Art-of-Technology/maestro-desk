import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';
import { getDb } from '../lib/db.ts';

// Migration to Neon — Step 3. Member-level, workspace-scoped via getDb().
export const tags = new Hono();

tags.use('*', requireAuth);

// ─── GET / — list the workspace tag library with usage counts ────────────
// Counts come from a per-row subquery (manual tags against ticket_tags, AI
// tags against ticket_ai_tags) — the library set is small, so this is fine.
tags.get('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const rows = await sql`
    select l.tag, l.kind, l.ai_confidence,
      case when l.kind = 'ai'
        then (select count(*)::int from ticket_ai_tags a where a.workspace_id = l.workspace_id and a.tag = l.tag)
        else (select count(*)::int from ticket_tags m where m.workspace_id = l.workspace_id and m.tag = l.tag)
      end as count
    from tag_library l
    where l.workspace_id = ${workspaceId}
    order by l.tag asc
  `;
  return c.json({ tags: rows });
});

// ─── PATCH /:tag — change kind (manual ↔ ai) ─────────────────────────────
const PatchTag = z.object({
  kind:          z.enum(['manual', 'ai']).optional(),
  ai_confidence: z.number().int().min(0).max(100).nullable().optional(),
}).strict();

tags.patch('/:tag', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const tag = c.req.param('tag');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PatchTag.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: 'No fields to update' }, 400);

  // Flipping to manual clears confidence. Flipping to ai backfills a default
  // of 90 only when the row had no prior confidence (matches the SPA).
  const updates: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.kind === 'manual') {
    updates.ai_confidence = null;
  } else if (parsed.data.kind === 'ai' && parsed.data.ai_confidence === undefined) {
    const [current] = await sql`
      select ai_confidence from tag_library where workspace_id = ${workspaceId} and tag = ${tag}
    `;
    if (!current?.ai_confidence) updates.ai_confidence = 90;
  }

  const [row] = await sql`
    update tag_library set ${sql(updates)}
    where workspace_id = ${workspaceId} and tag = ${tag}
    returning tag, kind, ai_confidence
  `;
  if (!row) return c.json({ error: 'Tag not found' }, 404);
  return c.json({ tag: row });
});

// ─── DELETE /:tag — remove from library + strip from all tickets ─────────
tags.delete('/:tag', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const tag = c.req.param('tag');

  await sql`delete from ticket_tags    where workspace_id = ${workspaceId} and tag = ${tag}`;
  await sql`delete from ticket_ai_tags where workspace_id = ${workspaceId} and tag = ${tag}`;
  await sql`delete from tag_library    where workspace_id = ${workspaceId} and tag = ${tag}`;
  return new Response(null, { status: 204 });
});

// ─── POST /:tag/merge { into } — rename across tickets, drop source ──────
const PostMerge = z.object({
  into: z.string().min(1).max(64),
});

tags.post('/:tag/merge', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const source = c.req.param('tag');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PostMerge.safeParse(reqBody);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  const target = parsed.data.into;
  if (target === source) return c.json({ error: 'Source and target tags are the same' }, 400);

  // Target must already exist in the library — won't auto-create.
  const [targetRow] = await sql`
    select tag from tag_library where workspace_id = ${workspaceId} and tag = ${target}
  `;
  if (!targetRow) return c.json({ error: 'Target tag not found in library' }, 404);

  // For each tag table: first drop source rows on tickets that ALREADY carry
  // target (would collide on the (ticket_id, tag) PK), then rename the rest.
  for (const table of ['ticket_tags', 'ticket_ai_tags'] as const) {
    await sql`
      delete from ${sql(table)}
      where workspace_id = ${workspaceId} and tag = ${source}
        and ticket_id in (
          select ticket_id from ${sql(table)} where workspace_id = ${workspaceId} and tag = ${target}
        )
    `;
    await sql`
      update ${sql(table)} set tag = ${target}
      where workspace_id = ${workspaceId} and tag = ${source}
    `;
  }

  // Drop the source library row.
  await sql`delete from tag_library where workspace_id = ${workspaceId} and tag = ${source}`;

  return c.json({ source, target });
});
