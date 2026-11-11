import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../lib/db.js';
import { requireWorkspaceAdmin } from '../lib/authz.js';

// Migration to Neon — Step 3. Member-level, workspace-scoped via getDb().
export const tags = new Hono();

tags.use('*', requireAuth);
tags.use('*', async (c, next) => {
  if (c.req.method !== 'GET') {
    const denied = await requireWorkspaceAdmin(c);
    if (denied) return denied;
  }
  await next();
});

const TagName = z.string().trim().toLowerCase().transform(s => s.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''))
  .pipe(z.string().min(1).max(64));
const NewTag = z.object({
  tag: TagName,
  kind: z.enum(['manual', 'ai']).default('manual'),
  ai_confidence: z.number().int().min(0).max(100).nullable().optional(),
}).strict();

tags.post('/', async (c) => {
  const parsed = NewTag.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid tag', issues: parsed.error.issues }, 400);
  const sql = getDb(), d = parsed.data;
  const [row] = await sql`insert into tag_library (workspace_id, tag, kind, ai_confidence)
    values (${c.get('workspaceId')}, ${d.tag}, ${d.kind}, ${d.kind === 'manual' ? null : (d.ai_confidence ?? 90)})
    on conflict (workspace_id, tag) do nothing returning tag, kind, ai_confidence`;
  return row ? c.json({ tag: { ...row, count: 0 } }, 201) : c.json({ error: 'This tag already exists.' }, 409);
});

// ─── GET / — list the workspace tag library with usage counts ────────────
// Count applied tags; AI suggestions only count once accepted onto a ticket.
tags.get('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const rows = await sql`
    select l.tag, l.kind, l.ai_confidence,
      (select count(*)::int from ticket_tags m where m.workspace_id = l.workspace_id and m.tag = l.tag) as count
    from tag_library l
    where l.workspace_id = ${workspaceId}
    order by l.tag asc
  `;
  return c.json({ tags: rows });
});

// ─── PATCH /:tag — change kind (manual ↔ ai) ─────────────────────────────
const PatchTag = z.object({
  tag:           TagName.optional(),
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

  let row;
  try {
    row = await sql.begin(async tx => {
      const [saved] = await tx`update tag_library set ${tx(updates)}
        where workspace_id=${workspaceId} and tag=${tag} returning tag, kind, ai_confidence`;
      if (saved && saved.tag !== tag) {
        for (const table of ['ticket_tags', 'ticket_ai_tags'] as const) {
          await tx`update ${tx(table)} set tag=${saved.tag} where workspace_id=${workspaceId} and tag=${tag}`;
        }
      }
      return saved;
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return c.json({ error: 'This tag already exists. Use Merge instead.' }, 409);
    throw err;
  }
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

  const result = await sql.begin(async tx => {
    // shortcut: brief table locks cover every tag writer; use shared row-lock ordering if merge traffic grows.
    await tx`lock table tag_library, ticket_tags, ticket_ai_tags in share row exclusive mode`;
    const [sourceRow] = await tx`select * from tag_library where workspace_id=${workspaceId} and tag=${source}`;
    const [targetRow] = await tx`select * from tag_library where workspace_id=${workspaceId} and tag=${target}`;
    if (!sourceRow || !targetRow) return null;
    const [merge] = await tx`insert into tag_merges
      (workspace_id, source, target, source_kind, source_confidence, target_revision, assignment_count)
      values (${workspaceId}, ${source}, ${target}, ${sourceRow.kind}, ${sourceRow.ai_confidence}, ${targetRow.revision}, 0)
      returning id`;
    for (const [table, kind] of [['ticket_tags', 'manual'], ['ticket_ai_tags', 'ai']] as const) {
      await tx`insert into tag_merge_assignments
        (merge_id,ticket_id,kind,source_confidence,source_accepted,source_created_at,had_target,target_revision)
        select ${merge.id},s.ticket_id,${kind},${kind === 'ai' ? tx`s.confidence` : tx`null`},
          ${kind === 'ai' ? tx`s.accepted` : tx`null`},${kind === 'ai' ? tx`s.created_at` : tx`null`},t.revision is not null,s.revision
        from ${tx(table)} s
        left join ${tx(table)} t on t.workspace_id=s.workspace_id and t.ticket_id=s.ticket_id and t.tag=${target}
        where s.workspace_id=${workspaceId} and s.tag=${source}`;
      await tx`delete from ${tx(table)} s where s.workspace_id=${workspaceId} and s.tag=${source}
        and exists (select 1 from ${tx(table)} t where t.workspace_id=${workspaceId} and t.ticket_id=s.ticket_id and t.tag=${target})`;
      await tx`update ${tx(table)} set tag=${target} where workspace_id=${workspaceId} and tag=${source}`;
      await tx`update tag_merge_assignments a set target_revision=t.revision from ${tx(table)} t
        where a.merge_id=${merge.id} and a.kind=${kind} and t.workspace_id=${workspaceId} and t.ticket_id=a.ticket_id and t.tag=${target}`;
    }
    await tx`update tag_merges set assignment_count=(select count(*) from tag_merge_assignments where merge_id=${merge.id})
      where workspace_id=${workspaceId} and id=${merge.id}`;
    await tx`delete from tag_library where workspace_id=${workspaceId} and tag=${source}`;
    // A later merge into the same target makes earlier snapshots ambiguous.
    const [updatedTarget] = await tx`update tag_library set tag=tag where workspace_id=${workspaceId} and tag=${target} returning revision`;
    await tx`update tag_merges set target_revision=${updatedTarget.revision} where workspace_id=${workspaceId} and id=${merge.id}`;
    const [usage] = await tx`select count(*)::int as count from ticket_tags where workspace_id=${workspaceId} and tag=${target}`;
    return { id: merge.id, target_count: usage.count };
  });
  if (!result) return c.json({ error: 'Source or target tag not found in library' }, 404);
  return c.json({ source, target, merge_id: result.id, target_count: result.target_count });
});

tags.get('/merges', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;
  const sql = getDb();
  const merges = await sql`select id,source,target,assignment_count,created_at,undone_at from tag_merges
    where workspace_id=${c.get('workspaceId')} order by created_at desc, id desc`;
  return c.json({ merges });
});

tags.post('/merges/:id/undo', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'Invalid merge ID' }, 400);
  const sql = getDb(), workspaceId = c.get('workspaceId');
  const result = await sql.begin(async tx => {
    await tx`lock table tag_library, ticket_tags, ticket_ai_tags in share row exclusive mode`;
    const [merge] = await tx`select * from tag_merges where workspace_id=${workspaceId} and id=${id.data} for update`;
    if (!merge) return { status: 404 as const, error: 'Merge not found.' };
    if (merge.undone_at) return { status: 409 as const, error: 'This merge has already been undone.' };
    const [source] = await tx`select tag from tag_library where workspace_id=${workspaceId} and tag=${merge.source}`;
    const [target] = await tx`select revision from tag_library where workspace_id=${workspaceId} and tag=${merge.target}`;
    if (source || target?.revision !== merge.target_revision) {
      return { status: 409 as const, error: 'Cannot undo: one of these tags was edited, recreated, deleted or merged again.' };
    }
    const assignments = await tx`select a.* from tag_merge_assignments a join tag_merges m on m.id=a.merge_id
      where m.workspace_id=${workspaceId} and m.id=${merge.id}`;
    if (assignments.length !== merge.assignment_count) return { status: 409 as const, error: 'Cannot undo: an affected ticket was deleted.' };
    for (const [table, kind] of [['ticket_tags', 'manual'], ['ticket_ai_tags', 'ai']] as const) {
      const [changed] = await tx`select a.ticket_id from tag_merge_assignments a
        left join ${tx(table)} t on t.workspace_id=${workspaceId} and t.ticket_id=a.ticket_id and t.tag=${merge.target}
        where a.merge_id=${merge.id} and a.kind=${kind} and t.revision is distinct from a.target_revision limit 1`;
      if (changed) {
        return { status: 409 as const, error: 'Cannot undo: an affected ticket tag has changed since this merge. No tags were changed.' };
      }
    }
    await tx`insert into tag_library(workspace_id,tag,kind,ai_confidence)
      values (${workspaceId},${merge.source},${merge.source_kind},${merge.source_confidence})`;
    for (const [table, kind] of [['ticket_tags', 'manual'], ['ticket_ai_tags', 'ai']] as const) {
      await tx`delete from ${tx(table)} t using tag_merge_assignments a where a.merge_id=${merge.id}
        and a.kind=${kind} and not a.had_target and t.workspace_id=${workspaceId} and t.ticket_id=a.ticket_id and t.tag=${merge.target}`;
      if (kind === 'manual') {
        await tx`insert into ticket_tags(workspace_id,ticket_id,tag)
          select ${workspaceId},ticket_id,${merge.source} from tag_merge_assignments where merge_id=${merge.id} and kind=${kind}`;
      } else {
        await tx`insert into ticket_ai_tags(workspace_id,ticket_id,tag,confidence,accepted,created_at)
          select ${workspaceId},ticket_id,${merge.source},source_confidence,source_accepted,source_created_at
          from tag_merge_assignments where merge_id=${merge.id} and kind=${kind}`;
      }
    }
    await tx`update tag_merges set undone_at=now() where workspace_id=${workspaceId} and id=${merge.id}`;
    await tx`delete from tag_merge_assignments where merge_id in (select id from tag_merges where workspace_id=${workspaceId} and id=${merge.id})`;
    return { source: merge.source, target: merge.target, assignments };
  });
  if ('error' in result) return c.json({ error: result.error }, result.status);
  return c.json(result);
});
