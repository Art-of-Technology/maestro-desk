import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';
import { runWorkflowsForTicket } from '../lib/workflow-engine.ts';
import { applyAssignmentRules } from '../lib/assign-rules-engine.ts';
import { notifySlack } from '../lib/slack-notify.ts';

export const tickets = new Hono();

tickets.use('*', requireAuth);

// Pagination is offset-based for the skeleton; switch to keyset before
// ticket volumes get serious. Scoping is explicit because the API uses
// the service-role client (see comment in middleware/auth.ts).
tickets.get('/', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  const { data, error, count } = await sb
    .from('tickets')
    .select(
      'id, display_id, subject, status_key, priority_key, category_key, assigned_user_id, customer_id, sla_state, created_at, updated_at, snoozed_until, snoozed_at, snooze_reason, snooze_woken_at, merged_into_id, merged_at, status_before_merge',
      { count: 'exact' },
    )
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ tickets: data, total: count ?? 0, limit, offset });
});

// Full ticket detail — the row itself plus all of its child collections.
// Used by the SPA's ticket-detail view to populate the conversation thread,
// tags, AI tags, and time entries that aren't returned by the list endpoint.
//
// 4 parallel queries instead of one big embedded select — clearer to read
// and to debug, with no measurable latency cost at v1 scale.
tickets.get('/:id', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const ticketId = c.req.param('id');

  const { data: ticket, error: tErr } = await sb
    .from('tickets')
    .select('*')
    .eq('id', ticketId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .maybeSingle();
  if (tErr) return c.json({ error: tErr.message }, 500);
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

  // Messages query carries merged_from_id so the client can mark which
  // turns came from a merged-in source ticket.
  const [msgsRes, tagsRes, aiTagsRes, timeRes, mergedFromRes, mergedIntoRes] = await Promise.all([
    sb.from('ticket_messages')
      .select('id, role, author_user_id, author_label, body, mentions, merged_from_id, created_at')
      .eq('ticket_id', ticketId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true }),
    sb.from('ticket_tags')
      .select('tag')
      .eq('ticket_id', ticketId),
    sb.from('ticket_ai_tags')
      .select('tag, confidence, accepted')
      .eq('ticket_id', ticketId)
      .order('confidence', { ascending: false }),
    sb.from('time_entries')
      .select('id, user_id, minutes, note, billable, created_at, users(name)')
      .eq('ticket_id', ticketId)
      .order('created_at', { ascending: false }),
    // Children: tickets whose merged_into_id points at us. Returned as
    // display_ids so the UI can deep-link without an extra fetch.
    sb.from('tickets')
      .select('display_id')
      .eq('merged_into_id', ticketId)
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null),
    // Parent: if this ticket is itself merged, fetch the primary's display_id.
    ticket.merged_into_id
      ? sb.from('tickets')
          .select('display_id')
          .eq('id', ticket.merged_into_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null } as any),
  ]);

  const firstErr = [msgsRes, tagsRes, aiTagsRes, timeRes, mergedFromRes, mergedIntoRes].find((r) => r.error);
  if (firstErr?.error) return c.json({ error: firstErr.error.message }, 500);

  return c.json({
    ticket: {
      ...ticket,
      messages:     msgsRes.data || [],
      tags:         (tagsRes.data || []).map((r: any) => r.tag),
      ai_tags:      aiTagsRes.data || [],
      time_entries: (timeRes.data || []).map((te: any) => ({
        id:         te.id,
        user_id:    te.user_id,
        user_name:  te.users?.name || null,
        minutes:    te.minutes,
        note:       te.note,
        billable:   te.billable,
        created_at: te.created_at,
      })),
      merged_from_display_ids: (mergedFromRes.data || []).map((r: any) => r.display_id),
      merged_into_display_id:  (mergedIntoRes as any)?.data?.display_id || null,
    },
  });
});

// ─── PATCH /:id — update status / priority / assignment / category ───────
//
// All fields optional; only provided ones are written. Empty body is a
// 400 (probably a client bug, fail loudly). assigned_user_id may be null
// to unassign.
const PatchTicket = z.object({
  status_key:        z.string().optional(),
  priority_key:      z.string().optional(),
  category_key:      z.string().nullable().optional(),
  assigned_user_id:  z.string().uuid().nullable().optional(),
  // CSAT fields — the schema defaults to YYYY-MM-DD when written from the
  // SPA, but the column is timestamptz so any Postgres-parseable timestamp
  // is fine. Bad values bubble up as DB errors.
  csat_score:        z.number().int().min(1).max(5).nullable().optional(),
  csat_stars:        z.number().int().min(1).max(5).nullable().optional(),
  csat_comment:      z.string().nullable().optional(),
  csat_requested_at: z.string().nullable().optional(),
  csat_submitted_at: z.string().nullable().optional(),
}).strict();

tickets.patch('/:id', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const ticketId = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = PatchTicket.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const updates = parsed.data;
  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  // Workspace-scope check before the update so an attacker with a valid
  // ticket UUID from another workspace can't blind-write through the
  // service-role client. Also captures the pre-update column values the
  // workflow engine compares against for change-detection triggers
  // (status_change / priority_change / etc.).
  const { data: existing, error: lookupErr } = await sb
    .from('tickets')
    .select('id, status_key, priority_key, category_key, assigned_user_id')
    .eq('id', ticketId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .maybeSingle();
  if (lookupErr) return c.json({ error: lookupErr.message }, 500);
  if (!existing)  return c.json({ error: 'Ticket not found' }, 404);

  const { error: updErr } = await sb
    .from('tickets')
    .update(updates)
    .eq('id', ticketId)
    .eq('workspace_id', workspaceId);
  if (updErr) return c.json({ error: updErr.message }, 500);

  // Fire workflow engine against the post-update row. The engine may
  // mutate further fields (assign_role / set_status / add_tag), so we
  // re-fetch below to return the canonical post-engine state.
  try { await runWorkflowsForTicket({ sb, workspaceId, ticketId, prevRow: existing }); }
  catch (err) { console.error('[workflow-engine] top-level failure:', err); }

  // Slack notifications for the state transitions the workspace cares
  // about. Fired AFTER the workflow engine so the Slack message reflects
  // any engine-driven follow-up updates (e.g. assign_role).
  const statusChanged   = updates.status_key   !== undefined && updates.status_key   !== existing.status_key;
  const priorityChanged = updates.priority_key !== undefined && updates.priority_key !== existing.priority_key;
  if (statusChanged && updates.status_key === 'resolved') {
    try { await notifySlack({ sb, workspaceId, event: 'ticket.resolved',  ticketId }); }
    catch (err) { console.warn('[slack] notify resolved failed:', err); }
  }
  if (statusChanged && updates.status_key === 'escalated') {
    try { await notifySlack({ sb, workspaceId, event: 'ticket.escalated', ticketId }); }
    catch (err) { console.warn('[slack] notify escalated failed:', err); }
  }
  if (priorityChanged && updates.priority_key === 'urgent') {
    try { await notifySlack({ sb, workspaceId, event: 'priority.urgent',  ticketId }); }
    catch (err) { console.warn('[slack] notify urgent failed:', err); }
  }

  const { data: updated, error: refetchErr } = await sb
    .from('tickets')
    .select('id, display_id, status_key, priority_key, category_key, assigned_user_id, sla_state, updated_at, csat_score, csat_stars, csat_comment, csat_requested_at, csat_submitted_at')
    .eq('id', ticketId)
    .eq('workspace_id', workspaceId)
    .single();
  if (refetchErr) return c.json({ error: refetchErr.message }, 500);

  return c.json({ ticket: updated });
});

// ─── POST /:id/messages — agent reply or internal note ───────────────────
const PostMessage = z.object({
  role:     z.enum(['agent', 'note']),
  body:     z.string().min(1),
  mentions: z.array(z.string().uuid()).optional(),
});

tickets.post('/:id/messages', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const ticketId = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PostMessage.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  const { data: ticket, error: tErr } = await sb
    .from('tickets')
    .select('id')
    .eq('id', ticketId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .maybeSingle();
  if (tErr) return c.json({ error: tErr.message }, 500);
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

  // Resolve author display name from public.users so the row carries the
  // canonical name without trusting the client.
  const { data: user, error: uErr } = await sb
    .from('users')
    .select('name, email')
    .eq('id', userId)
    .maybeSingle();
  if (uErr) return c.json({ error: uErr.message }, 500);
  const authorLabel = user?.name || user?.email || 'Agent';

  const { data: message, error: mErr } = await sb
    .from('ticket_messages')
    .insert({
      workspace_id:   workspaceId,
      ticket_id:      ticketId,
      role:           input.role,
      author_user_id: userId,
      author_label:   authorLabel,
      body:           input.body,
      mentions:       input.mentions || [],
    })
    .select('id, role, author_user_id, author_label, body, mentions, created_at')
    .single();
  if (mErr) return c.json({ error: mErr.message }, 500);

  return c.json({ message }, 201);
});

// ─── POST /:id/tags — add a manual tag ───────────────────────────────────
//
// Tag is normalised the same way the SPA used to (lowercase, hyphenated,
// alphanumeric-only) so a value that round-trips through the API matches
// what `data.js` set. On insert, also upsert into tag_library so the
// workspace's tag catalogue stays in sync — kind='manual', no confidence.
const PostTag = z.object({
  tag: z.string().min(1).max(64),
});

function normaliseTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

tickets.post('/:id/tags', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const ticketId = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PostTag.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const tag = normaliseTag(parsed.data.tag);
  if (!tag) return c.json({ error: 'Tag is empty after normalisation' }, 400);

  // Confirm ticket exists in this workspace.
  const { data: ticket, error: tErr } = await sb
    .from('tickets')
    .select('id')
    .eq('id', ticketId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .maybeSingle();
  if (tErr) return c.json({ error: tErr.message }, 500);
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

  // Idempotent — ON CONFLICT does nothing because (ticket_id, tag) is the PK.
  const { error: insErr } = await sb
    .from('ticket_tags')
    .upsert(
      { workspace_id: workspaceId, ticket_id: ticketId, tag },
      { onConflict: 'ticket_id,tag', ignoreDuplicates: true },
    );
  if (insErr) return c.json({ error: insErr.message }, 500);

  // Keep the workspace tag library populated. Best-effort — failure here
  // shouldn't fail the request because the ticket_tags row already landed.
  const { error: libErr } = await sb
    .from('tag_library')
    .upsert(
      { workspace_id: workspaceId, tag, kind: 'manual' },
      { onConflict: 'workspace_id,tag', ignoreDuplicates: true },
    );
  if (libErr) console.warn('[tickets] tag_library upsert failed:', libErr.message);

  return c.json({ tag }, 201);
});

// ─── DELETE /:id/tags/:tag — remove a manual tag ─────────────────────────
//
// Tags are unique by (ticket_id, tag), so we route by URL. Returns 204
// on success whether or not the tag was actually present (idempotent).
tickets.delete('/:id/tags/:tag', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const ticketId = c.req.param('id');
  const tag = normaliseTag(c.req.param('tag'));

  // Workspace-scope check.
  const { data: ticket, error: tErr } = await sb
    .from('tickets')
    .select('id')
    .eq('id', ticketId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .maybeSingle();
  if (tErr) return c.json({ error: tErr.message }, 500);
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

  const { error: delErr } = await sb
    .from('ticket_tags')
    .delete()
    .eq('ticket_id', ticketId)
    .eq('tag', tag);
  if (delErr) return c.json({ error: delErr.message }, 500);

  return new Response(null, { status: 204 });
});

// ─── PATCH /:id/ai_tags/:tag — accept an AI-suggested tag ────────────────
//
// The UI only ever flips accepted=true (there's no "un-accept" button).
// On accept, also writes a ticket_tags row so the accepted suggestion
// becomes a real manual tag — single source of truth for "what tags does
// this ticket have" stays the manual tags array. tag_library upsert is
// best-effort, same shape as POST /tags.
const PatchAITag = z.object({
  accepted: z.literal(true),
});

tickets.patch('/:id/ai_tags/:tag', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const ticketId = c.req.param('id');
  const tag = c.req.param('tag');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PatchAITag.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }

  // Workspace-scope check + confirm the AI tag actually exists on this
  // ticket. Catches stale UI submitting an accept for a tag the server
  // no longer has.
  const { data: existing, error: lookupErr } = await sb
    .from('ticket_ai_tags')
    .select('tag, accepted, ticket_id, tickets!inner(workspace_id, deleted_at)')
    .eq('ticket_id', ticketId)
    .eq('tag', tag)
    .maybeSingle();
  if (lookupErr) return c.json({ error: lookupErr.message }, 500);
  if (!existing) return c.json({ error: 'AI tag not found' }, 404);
  const parent = (Array.isArray(existing.tickets) ? existing.tickets[0] : existing.tickets) as
    | { workspace_id: string; deleted_at: string | null }
    | null;
  if (!parent || parent.workspace_id !== workspaceId || parent.deleted_at) {
    return c.json({ error: 'AI tag not found' }, 404);
  }

  // 1. Flip accepted=true on the ai_tags row (no-op if already accepted).
  const { error: updErr } = await sb
    .from('ticket_ai_tags')
    .update({ accepted: true })
    .eq('ticket_id', ticketId)
    .eq('tag', tag);
  if (updErr) return c.json({ error: updErr.message }, 500);

  // 2. Promote to a manual ticket_tags row. Idempotent via the PK.
  const { error: insErr } = await sb
    .from('ticket_tags')
    .upsert(
      { workspace_id: workspaceId, ticket_id: ticketId, tag },
      { onConflict: 'ticket_id,tag', ignoreDuplicates: true },
    );
  if (insErr) return c.json({ error: insErr.message }, 500);

  // 3. Keep the workspace tag library populated. Best-effort.
  const { error: libErr } = await sb
    .from('tag_library')
    .upsert(
      { workspace_id: workspaceId, tag, kind: 'manual' },
      { onConflict: 'workspace_id,tag', ignoreDuplicates: true },
    );
  if (libErr) console.warn('[tickets] tag_library upsert failed:', libErr.message);

  return c.json({ tag, accepted: true });
});

// ─── POST /:id/snooze — set snoozed_until + reason ───────────────────────
//
// Server stamps snoozed_at, snoozed_by_user_id, and clears any prior
// snooze_woken_at so re-snoozing a previously-woken ticket reads as fresh.
// `until` must be a future ISO timestamp.
const PostSnooze = z.object({
  until:  z.string().datetime({ offset: true }),
  reason: z.string().nullable().optional(),
});

tickets.post('/:id/snooze', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const ticketId = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PostSnooze.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const { until, reason } = parsed.data;
  if (new Date(until).getTime() <= Date.now()) {
    return c.json({ error: 'Snooze time must be in the future' }, 400);
  }

  // Workspace-scope check.
  const { data: existing, error: lookupErr } = await sb
    .from('tickets')
    .select('id')
    .eq('id', ticketId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .maybeSingle();
  if (lookupErr) return c.json({ error: lookupErr.message }, 500);
  if (!existing)  return c.json({ error: 'Ticket not found' }, 404);

  const { data: updated, error: updErr } = await sb
    .from('tickets')
    .update({
      snoozed_until:      until,
      snoozed_at:         new Date().toISOString(),
      snoozed_by_user_id: userId,
      snooze_reason:      reason || null,
      snooze_woken_at:    null,
    })
    .eq('id', ticketId)
    .eq('workspace_id', workspaceId)
    .select('id, snoozed_until, snoozed_at, snoozed_by_user_id, snooze_reason, snooze_woken_at, updated_at')
    .single();
  if (updErr) return c.json({ error: updErr.message }, 500);

  return c.json({ ticket: updated });
});

// ─── DELETE /:id/snooze — clear snooze (manual or auto wakeup) ───────────
//
// ?via_wakeup=true → server stamps snooze_woken_at = now() so the activity
// log can distinguish "snooze elapsed" from "agent un-snoozed manually".
tickets.delete('/:id/snooze', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const ticketId = c.req.param('id');
  const viaWakeup = c.req.query('via_wakeup') === 'true';

  const { data: existing, error: lookupErr } = await sb
    .from('tickets')
    .select('id')
    .eq('id', ticketId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .maybeSingle();
  if (lookupErr) return c.json({ error: lookupErr.message }, 500);
  if (!existing)  return c.json({ error: 'Ticket not found' }, 404);

  const { data: updated, error: updErr } = await sb
    .from('tickets')
    .update({
      snoozed_until:      null,
      snoozed_at:         null,
      snoozed_by_user_id: null,
      snooze_reason:      null,
      snooze_woken_at:    viaWakeup ? new Date().toISOString() : null,
    })
    .eq('id', ticketId)
    .eq('workspace_id', workspaceId)
    .select('id, snoozed_until, snoozed_at, snoozed_by_user_id, snooze_reason, snooze_woken_at, updated_at')
    .single();
  if (updErr) return c.json({ error: updErr.message }, 500);

  return c.json({ ticket: updated });
});

// ─── POST /:id/merge — merge this ticket into another as a duplicate ─────
//
// :id is the SOURCE (the duplicate); body's into_id is the PRIMARY (the
// one that keeps the customer-facing thread). Server:
//   1. Validates both tickets exist in workspace; primary isn't itself merged.
//   2. Stamps merged_into_id, merged_at, status_before_merge on source.
//   3. Copies source's messages to primary with merged_from_id=source so
//      the primary's thread shows the merged history. Existing primary
//      messages aren't touched.
//   4. Inserts a "── Merged from TK-XXX ──" system marker on primary.
//   5. Resolves the source ticket (status_key='resolved') if it wasn't
//      already, so it leaves the open queue.
const PostMerge = z.object({
  into_id: z.string().uuid(),
});

tickets.post('/:id/merge', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const sourceId = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PostMerge.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const primaryId = parsed.data.into_id;
  if (primaryId === sourceId) {
    return c.json({ error: 'Cannot merge a ticket into itself' }, 400);
  }

  // Fetch both tickets in the workspace.
  const { data: rows, error: fetchErr } = await sb
    .from('tickets')
    .select('id, display_id, subject, status_key, merged_into_id')
    .in('id', [sourceId, primaryId])
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null);
  if (fetchErr) return c.json({ error: fetchErr.message }, 500);
  const source = (rows || []).find((r) => r.id === sourceId);
  const primary = (rows || []).find((r) => r.id === primaryId);
  if (!source)  return c.json({ error: 'Source ticket not found' }, 404);
  if (!primary) return c.json({ error: 'Primary ticket not found' }, 404);
  if (source.merged_into_id) {
    return c.json({ error: 'Source is already merged' }, 409);
  }
  if (primary.merged_into_id) {
    return c.json({ error: 'Primary is itself a duplicate — pick the chain primary instead' }, 409);
  }

  // 1. Update source row.
  const wasResolved = source.status_key === 'resolved';
  const { error: updErr } = await sb
    .from('tickets')
    .update({
      merged_into_id:      primaryId,
      merged_at:           new Date().toISOString(),
      status_before_merge: wasResolved ? null : source.status_key,
      status_key:          'resolved',
    })
    .eq('id', sourceId)
    .eq('workspace_id', workspaceId);
  if (updErr) return c.json({ error: updErr.message }, 500);

  // 2. Copy source messages onto primary, tagged with merged_from_id.
  const { data: srcMsgs, error: msgsErr } = await sb
    .from('ticket_messages')
    .select('role, author_user_id, author_label, body, mentions, created_at')
    .eq('ticket_id', sourceId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true });
  if (msgsErr) return c.json({ error: msgsErr.message }, 500);

  const inserts: any[] = [
    // Merge marker first so it shows up at the top of the merged block.
    // mentions:[] is explicit because Supabase's batch insert sends every
    // key — missing → null, which violates the NOT NULL constraint even
    // though the column has a default.
    {
      workspace_id:   workspaceId,
      ticket_id:      primaryId,
      role:           'system',
      author_label:   'System',
      body:           `── Merged from ${source.display_id}: "${source.subject}" ──`,
      mentions:       [],
      merged_from_id: sourceId,
    },
    ...(srcMsgs || []).map((m: any) => ({
      workspace_id:   workspaceId,
      ticket_id:      primaryId,
      role:           m.role,
      author_user_id: m.author_user_id,
      author_label:   m.author_label,
      body:           m.body,
      mentions:       m.mentions || [],
      merged_from_id: sourceId,
    })),
  ];
  const { error: insErr } = await sb.from('ticket_messages').insert(inserts);
  if (insErr) return c.json({ error: insErr.message }, 500);

  return c.json({
    source: { id: sourceId, merged_into_display_id: primary.display_id },
    primary: { id: primaryId, display_id: primary.display_id },
  });
});

// ─── POST /:id/unmerge — undo a merge ────────────────────────────────────
//
// :id is the SOURCE (currently merged). Server:
//   1. Strips messages from the primary where merged_from_id = source.
//   2. Restores status_key from status_before_merge (default 'open' if
//      somehow missing — shouldn't happen for clean merges).
//   3. Clears merged_into_id, merged_at, status_before_merge.
tickets.post('/:id/unmerge', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const sourceId = c.req.param('id');

  const { data: source, error: fetchErr } = await sb
    .from('tickets')
    .select('id, merged_into_id, status_before_merge')
    .eq('id', sourceId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .maybeSingle();
  if (fetchErr) return c.json({ error: fetchErr.message }, 500);
  if (!source) return c.json({ error: 'Source ticket not found' }, 404);
  if (!source.merged_into_id) {
    return c.json({ error: 'Ticket is not merged' }, 409);
  }

  // 1. Strip merged messages from the primary.
  const { error: delErr } = await sb
    .from('ticket_messages')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('ticket_id', source.merged_into_id)
    .eq('merged_from_id', sourceId);
  if (delErr) return c.json({ error: delErr.message }, 500);

  // 2. Restore source row.
  const restoredStatus = source.status_before_merge || 'open';
  const { error: updErr } = await sb
    .from('tickets')
    .update({
      merged_into_id:      null,
      merged_at:           null,
      status_before_merge: null,
      status_key:          restoredStatus,
    })
    .eq('id', sourceId)
    .eq('workspace_id', workspaceId);
  if (updErr) return c.json({ error: updErr.message }, 500);

  return c.json({
    source: { id: sourceId, status_key: restoredStatus },
    primary: { id: source.merged_into_id },
  });
});

// ─── POST /:id/time — log a time entry ───────────────────────────────────
//
// minutes must be a positive integer. user_id is stamped from the JWT
// (the agent who clicked "Log time"), not trusted from the client.
const PostTime = z.object({
  minutes:  z.number().int().positive().max(60 * 24),  // max 24h per entry
  note:     z.string().nullable().optional(),
  billable: z.boolean().optional(),
});

tickets.post('/:id/time', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const ticketId = c.req.param('id');

  const reqBody = await c.req.json().catch(() => null);
  const parsed = PostTime.safeParse(reqBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const { minutes, note, billable } = parsed.data;

  // Workspace-scope check.
  const { data: ticket, error: tErr } = await sb
    .from('tickets')
    .select('id')
    .eq('id', ticketId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .maybeSingle();
  if (tErr) return c.json({ error: tErr.message }, 500);
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

  const { data: entry, error: insErr } = await sb
    .from('time_entries')
    .insert({
      workspace_id: workspaceId,
      ticket_id:    ticketId,
      user_id:      userId,
      minutes,
      note:         note ?? null,
      billable:     billable ?? true,
    })
    .select('id, user_id, minutes, note, billable, created_at, users(name)')
    .single();
  if (insErr) return c.json({ error: insErr.message }, 500);

  // Flatten the user join so the client gets a consistent shape with the
  // detail-endpoint time_entries payload.
  return c.json({
    entry: {
      id:         entry.id,
      user_id:    entry.user_id,
      user_name:  (entry as any).users?.name || null,
      minutes:    entry.minutes,
      note:       entry.note,
      billable:   entry.billable,
      created_at: entry.created_at,
    },
  }, 201);
});

// ─── DELETE /:id/time/:entryId — remove a time entry ─────────────────────
//
// Only the original logger can delete, with two escape hatches: platform
// admins (already past the auth middleware) and workspace-role admins.
// Mirrors the client-side guard.
tickets.delete('/:id/time/:entryId', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const ticketId = c.req.param('id');
  const entryId = c.req.param('entryId');

  const { data: entry, error: lookupErr } = await sb
    .from('time_entries')
    .select('id, user_id, workspace_id, ticket_id')
    .eq('id', entryId)
    .maybeSingle();
  if (lookupErr) return c.json({ error: lookupErr.message }, 500);
  if (!entry || entry.workspace_id !== workspaceId || entry.ticket_id !== ticketId) {
    return c.json({ error: 'Time entry not found' }, 404);
  }

  if (entry.user_id !== userId) {
    // Caller didn't log it — allow if they're a platform admin or a
    // workspace-role admin. Both checks in parallel.
    const [paRes, waRes] = await Promise.all([
      sb.from('users').select('is_platform_admin').eq('id', userId).maybeSingle(),
      sb.from('workspace_members')
        .select('roles(is_admin)')
        .eq('user_id', userId)
        .eq('workspace_id', workspaceId)
        .maybeSingle(),
    ]);
    const isPlatformAdmin  = Boolean(paRes.data?.is_platform_admin);
    const isWorkspaceAdmin = Boolean((waRes.data as any)?.roles?.is_admin);
    if (!isPlatformAdmin && !isWorkspaceAdmin) {
      return c.json({ error: 'Only the original logger or an admin can remove this entry' }, 403);
    }
  }

  const { error: delErr } = await sb
    .from('time_entries')
    .delete()
    .eq('id', entryId);
  if (delErr) return c.json({ error: delErr.message }, 500);

  return new Response(null, { status: 204 });
});

// ─── POST /:id/apply-rules — run assignment rules against this ticket ──
//
// Returns { matched: false } when no rule fires (rule.matchCount stays
// flat, no ticket update). Otherwise { matched: true, rule, ticket }
// reflecting the post-engine state.
tickets.post('/:id/apply-rules', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const ticketId = c.req.param('id');

  const result = await applyAssignmentRules({ sb, workspaceId, ticketId });
  if (!result) return c.json({ matched: false });

  const { data: ticket } = await sb
    .from('tickets')
    .select('id, display_id, assigned_user_id, status_key, priority_key, category_key')
    .eq('id', ticketId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  return c.json({
    matched:  true,
    rule:     { id: result.rule_id, name: result.rule_name },
    ticket,
  });
});

const CreateTicket = z.object({
  subject: z.string().min(1).max(500),
  customer_id: z.string().uuid(),
  status_key: z.string().default('open'),
  priority_key: z.string().default('normal'),
  category_key: z.string().optional(),
  initial_message: z.string().min(1).optional(),
});

tickets.post('/', async (c) => {
  const sb = c.get('sb');
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');

  const body = await c.req.json().catch(() => null);
  const parsed = CreateTicket.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  // display_id allocation is a placeholder — replace with a per-workspace
  // sequence (or trigger) before this is exposed to real users.
  const displayId = `TK-${Math.floor(Math.random() * 900000 + 100000)}`;

  const { data: ticket, error: tErr } = await sb
    .from('tickets')
    .insert({
      workspace_id: workspaceId,
      display_id: displayId,
      subject: input.subject,
      customer_id: input.customer_id,
      status_key: input.status_key,
      priority_key: input.priority_key,
      category_key: input.category_key ?? null,
      assigned_user_id: userId,
    })
    .select('id, display_id')
    .single();
  if (tErr) return c.json({ error: tErr.message }, 500);

  if (input.initial_message) {
    const { error: mErr } = await sb.from('ticket_messages').insert({
      workspace_id: workspaceId,
      ticket_id: ticket.id,
      role: 'customer',
      author_label: 'API caller',
      body: input.initial_message,
    });
    if (mErr) return c.json({ error: mErr.message, ticket }, 500);
  }

  // Auto-apply assignment rules on the freshly-created ticket. Errors
  // swallowed (logged) so a misconfigured rule can't break ticket
  // creation. POST currently stamps assigned_user_id=userId (the
  // creating agent); the engine may override that with a rule's pick.
  try { await applyAssignmentRules({ sb, workspaceId, ticketId: ticket.id }); }
  catch (err) { console.error('[assign-rules-engine] post-create failure:', err); }

  // Slack notification on creation.
  try { await notifySlack({ sb, workspaceId, event: 'ticket.created', ticketId: ticket.id }); }
  catch (err) { console.warn('[slack] notify created failed:', err); }

  return c.json({ ticket }, 201);
});
