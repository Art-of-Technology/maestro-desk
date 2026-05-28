import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';

export const tags = new Hono();

tags.use('*', requireAuth);

// ─── GET / — list the workspace tag library with usage counts ────────────
//
// Counts are computed client-side here from in-memory aggregates because
// supabase-js doesn't sugar GROUP BY aggregates and the tag-library set
// is small (10s, not 1000s). Manual tags count against ticket_tags; AI
// tags count against ticket_ai_tags.
tags.get('/', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');

  const [libRes, manualRes, aiRes] = await Promise.all([
    sb.from('tag_library')
      .select('tag, kind, ai_confidence')
      .eq('workspace_id', workspaceId)
      .order('tag', { ascending: true }),
    sb.from('ticket_tags')
      .select('tag')
      .eq('workspace_id', workspaceId),
    sb.from('ticket_ai_tags')
      .select('tag')
      .eq('workspace_id', workspaceId),
  ]);
  if (libRes.error)    return c.json({ error: libRes.error.message }, 500);
  if (manualRes.error) return c.json({ error: manualRes.error.message }, 500);
  if (aiRes.error)     return c.json({ error: aiRes.error.message }, 500);

  const manualCount: Record<string, number> = {};
  for (const r of manualRes.data || []) manualCount[r.tag] = (manualCount[r.tag] || 0) + 1;
  const aiCount: Record<string, number> = {};
  for (const r of aiRes.data || []) aiCount[r.tag] = (aiCount[r.tag] || 0) + 1;

  const out = (libRes.data || []).map((r: any) => ({
    tag:            r.tag,
    kind:           r.kind,
    ai_confidence:  r.ai_confidence,
    count:          r.kind === 'ai' ? (aiCount[r.tag] || 0) : (manualCount[r.tag] || 0),
  }));

  return c.json({ tags: out });
});

// ─── PATCH /:tag — change kind (manual ↔ ai) ─────────────────────────────
const PatchTag = z.object({
  kind:           z.enum(['manual', 'ai']).optional(),
  ai_confidence:  z.number().int().min(0).max(100).nullable().optional(),
}).strict();

tags.patch('/:tag', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const tag = c.req.param('tag');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PatchTag.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }
  // Flipping to manual clears the confidence. Flipping to ai backfills
  // a default of 90 only when the row had no prior confidence — matches
  // `t.conf = t.conf || 90` in the SPA. Look up the current value to
  // know whether to backfill.
  const updates: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.kind === 'manual') {
    updates.ai_confidence = null;
  } else if (parsed.data.kind === 'ai' && parsed.data.ai_confidence === undefined) {
    const { data: current } = await sb
      .from('tag_library')
      .select('ai_confidence')
      .eq('workspace_id', workspaceId)
      .eq('tag', tag)
      .maybeSingle();
    if (!current?.ai_confidence) updates.ai_confidence = 90;
  }

  const { data, error } = await sb
    .from('tag_library')
    .update(updates)
    .eq('workspace_id', workspaceId)
    .eq('tag', tag)
    .select('tag, kind, ai_confidence')
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data)  return c.json({ error: 'Tag not found' }, 404);
  return c.json({ tag: data });
});

// ─── DELETE /:tag — remove from library + strip from all tickets ─────────
tags.delete('/:tag', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const tag = c.req.param('tag');

  // Strip from ticket_tags + ticket_ai_tags first so an FK weirdness on
  // the library can't leave orphans. tag_library has no FK from these
  // sibling tables (just a shared (workspace_id, tag) composite key by
  // convention), so the order is for cleanliness, not correctness.
  const [m, a, l] = await Promise.all([
    sb.from('ticket_tags').delete().eq('workspace_id', workspaceId).eq('tag', tag),
    sb.from('ticket_ai_tags').delete().eq('workspace_id', workspaceId).eq('tag', tag),
    sb.from('tag_library').delete().eq('workspace_id', workspaceId).eq('tag', tag),
  ]);
  if (m.error) return c.json({ error: m.error.message }, 500);
  if (a.error) return c.json({ error: a.error.message }, 500);
  if (l.error) return c.json({ error: l.error.message }, 500);

  return new Response(null, { status: 204 });
});

// ─── POST /:tag/merge { into } — rename across tickets, drop source ──────
const PostMerge = z.object({
  into: z.string().min(1).max(64),
});

tags.post('/:tag/merge', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const source = c.req.param('tag');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PostMerge.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const target = parsed.data.into;
  if (target === source) return c.json({ error: 'Source and target tags are the same' }, 400);

  // Confirm target exists in the library — won't auto-create.
  const { data: targetRow, error: targetErr } = await sb
    .from('tag_library')
    .select('tag')
    .eq('workspace_id', workspaceId)
    .eq('tag', target)
    .maybeSingle();
  if (targetErr) return c.json({ error: targetErr.message }, 500);
  if (!targetRow) return c.json({ error: 'Target tag not found in library' }, 404);

  // For ticket_tags: rename source → target where the ticket doesn't
  // already have target (avoids PK conflict); delete remaining source rows.
  const { data: existingTargetTickets, error: ettErr } = await sb
    .from('ticket_tags')
    .select('ticket_id')
    .eq('workspace_id', workspaceId)
    .eq('tag', target);
  if (ettErr) return c.json({ error: ettErr.message }, 500);
  const targetTicketIds = new Set((existingTargetTickets || []).map((r) => r.ticket_id));

  const { data: sourceTickets, error: stErr } = await sb
    .from('ticket_tags')
    .select('ticket_id')
    .eq('workspace_id', workspaceId)
    .eq('tag', source);
  if (stErr) return c.json({ error: stErr.message }, 500);

  const renameIds  = (sourceTickets || []).map((r) => r.ticket_id).filter((id) => !targetTicketIds.has(id));
  const deleteIds  = (sourceTickets || []).map((r) => r.ticket_id).filter((id) =>  targetTicketIds.has(id));

  if (renameIds.length > 0) {
    const { error: renErr } = await sb
      .from('ticket_tags')
      .update({ tag: target })
      .eq('workspace_id', workspaceId)
      .eq('tag', source)
      .in('ticket_id', renameIds);
    if (renErr) return c.json({ error: renErr.message }, 500);
  }
  if (deleteIds.length > 0) {
    const { error: delErr } = await sb
      .from('ticket_tags')
      .delete()
      .eq('workspace_id', workspaceId)
      .eq('tag', source)
      .in('ticket_id', deleteIds);
    if (delErr) return c.json({ error: delErr.message }, 500);
  }

  // Same dance for ai_tags.
  const { data: aiTargetTickets, error: attErr } = await sb
    .from('ticket_ai_tags')
    .select('ticket_id')
    .eq('workspace_id', workspaceId)
    .eq('tag', target);
  if (attErr) return c.json({ error: attErr.message }, 500);
  const aiTargetIds = new Set((aiTargetTickets || []).map((r) => r.ticket_id));

  const { data: aiSourceTickets, error: astErr } = await sb
    .from('ticket_ai_tags')
    .select('ticket_id')
    .eq('workspace_id', workspaceId)
    .eq('tag', source);
  if (astErr) return c.json({ error: astErr.message }, 500);

  const aiRenameIds = (aiSourceTickets || []).map((r) => r.ticket_id).filter((id) => !aiTargetIds.has(id));
  const aiDeleteIds = (aiSourceTickets || []).map((r) => r.ticket_id).filter((id) =>  aiTargetIds.has(id));

  if (aiRenameIds.length > 0) {
    const { error: aiRenErr } = await sb
      .from('ticket_ai_tags')
      .update({ tag: target })
      .eq('workspace_id', workspaceId)
      .eq('tag', source)
      .in('ticket_id', aiRenameIds);
    if (aiRenErr) return c.json({ error: aiRenErr.message }, 500);
  }
  if (aiDeleteIds.length > 0) {
    const { error: aiDelErr } = await sb
      .from('ticket_ai_tags')
      .delete()
      .eq('workspace_id', workspaceId)
      .eq('tag', source)
      .in('ticket_id', aiDeleteIds);
    if (aiDelErr) return c.json({ error: aiDelErr.message }, 500);
  }

  // Finally, drop the source tag_library row.
  const { error: libErr } = await sb
    .from('tag_library')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('tag', source);
  if (libErr) return c.json({ error: libErr.message }, 500);

  return c.json({ source, target });
});
