import { Hono } from 'hono';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuth } from '../middleware/auth.ts';

export const presence = new Hono();

presence.use('*', requireAuth);

// Generic presence — same shape as the per-ticket viewer roster
// introduced in PR #236, generalised in PR #239 to cover any entity
// type (ticket today; customer / kb_article / dashboard tomorrow).
//
// One round-trip per heartbeat: upsert the caller's row, return the
// roster of OTHER viewers currently active. The activity window has
// to be longer than the client heartbeat (5s) plus tolerance for a
// missed beat — 15s gives one missed heartbeat of slack before a
// chip disappears.

const VIEWER_WINDOW_S = 15;

// entity_type is free-form text in the table; the API gates it to a
// known set so a typo can't write a row that nobody else reads. Add
// entries here as new surfaces opt in to presence.
const KNOWN_ENTITY_TYPES = new Set(['ticket', 'customer', 'kb_article']);

const PostPresence = z.object({
  composing: z.boolean().optional().default(false),
}).strict();

type UserRef = { name: string | null; initials: string | null };
// PostgREST returns a to-one FK embed as either a single object OR a
// single-element array depending on the generated relationship cardinality.
// Both shapes happen for `users(...)` embeds in this codebase;
// flattenUser collapses to UserRef | null at the boundary.
type ViewerRow = {
  user_id: string;
  last_seen_at: string;
  composing: boolean;
  composing_at: string | null;
  users: UserRef | UserRef[] | null;
};

function flattenUser(u: ViewerRow['users']): UserRef | null {
  if (!u) return null;
  return Array.isArray(u) ? (u[0] ?? null) : u;
}

function deriveInitials(name: string | null | undefined): string {
  if (!name) return '?';
  return name.split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// For entity_type='ticket' the heartbeat also serves as the live-sync
// probe added in PR #237 — we tack ticket_updated_at on the response
// so the SPA can detect cross-agent ticket mutations without a second
// round-trip. Other entity types skip this lookup; their detail views
// either don't need live-sync (KB read) or aren't built yet.
async function loadTicketUpdatedAt(sb: SupabaseClient, workspaceId: string, ticketId: string) {
  const { data, error } = await sb
    .from('tickets')
    .select('id, updated_at')
    .eq('id', ticketId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .maybeSingle();
  return {
    error:  error ?? null,
    ticket: (data as { id: string; updated_at: string } | null) ?? null,
  };
}

presence.post('/:entityType/:entityId', async (c) => {
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const entityType = c.req.param('entityType');
  const entityId   = c.req.param('entityId');

  if (!KNOWN_ENTITY_TYPES.has(entityType)) {
    return c.json({ error: 'Unknown entity_type' }, 400);
  }
  if (!UUID_RE.test(entityId)) {
    return c.json({ error: 'entity_id must be a UUID' }, 400);
  }

  const reqBody = await c.req.json().catch(() => ({}));
  const parsed = PostPresence.safeParse(reqBody ?? {});
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const { composing } = parsed.data;

  // Entity-scope check. For ticket entity_type we also use the lookup
  // result to surface ticket_updated_at on the response (live-sync
  // piggyback from PR #237). New entity types add their own lookup
  // when they want to bind workspace + sanity-check existence.
  let ticketUpdatedAt: string | null = null;
  if (entityType === 'ticket') {
    const { error, ticket } = await loadTicketUpdatedAt(sb, workspaceId, entityId);
    if (error)   return c.json({ error: error.message }, 500);
    if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
    ticketUpdatedAt = ticket.updated_at;
  }

  const nowIso = new Date().toISOString();

  // composing_at tracks the latest beat where composing was true (not
  // first started typing) — see PR #237 for the rationale on dropping
  // the prior-row read to keep the heartbeat at 2 DB round-trips.
  const { error: upsertErr } = await sb
    .from('presence')
    .upsert({
      workspace_id: workspaceId,
      entity_type:  entityType,
      entity_id:    entityId,
      user_id:      userId,
      last_seen_at: nowIso,
      composing,
      composing_at: composing ? nowIso : null,
    }, { onConflict: 'workspace_id,entity_type,entity_id,user_id' });
  if (upsertErr) return c.json({ error: upsertErr.message }, 500);

  // Read the live roster — other viewers active within the window. We
  // exclude self so the SPA doesn't have to filter; embedding users()
  // gives us name + initials for the chip.
  const cutoff = new Date(Date.now() - VIEWER_WINDOW_S * 1000).toISOString();
  const { data: viewers, error: rosterErr } = await sb
    .from('presence')
    .select('user_id, last_seen_at, composing, composing_at, users(name, initials)')
    .eq('workspace_id', workspaceId)
    .eq('entity_type',  entityType)
    .eq('entity_id',    entityId)
    .neq('user_id', userId)
    .gte('last_seen_at', cutoff)
    .order('last_seen_at', { ascending: false })
    .returns<ViewerRow[]>();
  if (rosterErr) return c.json({ error: rosterErr.message }, 500);

  const body: Record<string, unknown> = {
    viewers: (viewers || []).map((v) => {
      const u = flattenUser(v.users);
      return {
        user_id:      v.user_id,
        name:         u?.name || 'Someone',
        initials:     u?.initials || deriveInitials(u?.name),
        composing:    !!v.composing,
        composing_at: v.composing_at,
        last_seen_at: v.last_seen_at,
      };
    }),
    window_seconds: VIEWER_WINDOW_S,
  };
  if (ticketUpdatedAt) body.ticket_updated_at = ticketUpdatedAt;
  return c.json(body);
});

// Explicit leave — called via fetch keepalive on unload / route change
// so the caller's chip disappears immediately rather than waiting up
// to VIEWER_WINDOW_S for the stale row to age out.
presence.delete('/:entityType/:entityId', async (c) => {
  const sb = c.get('sbUser');
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const entityType = c.req.param('entityType');
  const entityId   = c.req.param('entityId');

  if (!KNOWN_ENTITY_TYPES.has(entityType)) {
    return c.json({ error: 'Unknown entity_type' }, 400);
  }
  if (!UUID_RE.test(entityId)) {
    return c.json({ error: 'entity_id must be a UUID' }, 400);
  }

  const { error } = await sb
    .from('presence')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('entity_type',  entityType)
    .eq('entity_id',    entityId)
    .eq('user_id',      userId);
  if (error) return c.json({ error: error.message }, 500);

  return c.body(null, 204);
});
