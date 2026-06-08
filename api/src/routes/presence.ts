import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.ts';
import { getDb } from '../lib/db.ts';

// Migration to Neon — Step 3. Generic presence (ticket / customer / kb_article
// today). One round-trip per heartbeat: upsert the caller's row, return the
// roster of OTHER viewers active within the window. Member-level, scoped to
// the active workspace + entity.
export const presence = new Hono();

presence.use('*', requireAuth);

const VIEWER_WINDOW_S = 15;
const KNOWN_ENTITY_TYPES = new Set(['ticket', 'customer', 'kb_article']);

const PostPresence = z.object({
  composing: z.boolean().optional().default(false),
}).strict();

function deriveInitials(name: string | null | undefined): string {
  if (!name) return '?';
  return name.split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

presence.post('/:entityType/:entityId', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const entityType = c.req.param('entityType');
  const entityId   = c.req.param('entityId');

  if (!KNOWN_ENTITY_TYPES.has(entityType)) return c.json({ error: 'Unknown entity_type' }, 400);
  if (!UUID_RE.test(entityId)) return c.json({ error: 'entity_id must be a UUID' }, 400);

  const reqBody = await c.req.json().catch(() => ({}));
  const parsed = PostPresence.safeParse(reqBody ?? {});
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  const { composing } = parsed.data;

  // For tickets, the heartbeat doubles as the live-sync probe — bind the
  // entity to the workspace + surface ticket.updated_at on the response.
  let ticketUpdatedAt: string | null = null;
  if (entityType === 'ticket') {
    const [ticket] = await sql`
      select updated_at from tickets
      where id = ${entityId} and workspace_id = ${workspaceId} and deleted_at is null
    `;
    if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
    ticketUpdatedAt = ticket.updated_at;
  }

  const nowIso = new Date().toISOString();
  await sql`
    insert into presence (workspace_id, entity_type, entity_id, user_id, last_seen_at, composing, composing_at)
    values (${workspaceId}, ${entityType}, ${entityId}, ${userId}, ${nowIso}, ${composing}, ${composing ? nowIso : null})
    on conflict (workspace_id, entity_type, entity_id, user_id) do update
      set last_seen_at = excluded.last_seen_at, composing = excluded.composing, composing_at = excluded.composing_at
  `;

  // Live roster — other viewers active within the window.
  const cutoff = new Date(Date.now() - VIEWER_WINDOW_S * 1000).toISOString();
  const viewers = await sql`
    select p.user_id, p.last_seen_at, p.composing, p.composing_at, u.name, u.initials
    from presence p
    left join users u on u.id = p.user_id
    where p.workspace_id = ${workspaceId} and p.entity_type = ${entityType} and p.entity_id = ${entityId}
      and p.user_id <> ${userId} and p.last_seen_at >= ${cutoff}
    order by p.last_seen_at desc
  `;

  const body: Record<string, unknown> = {
    viewers: viewers.map((v) => ({
      user_id:      v.user_id,
      name:         v.name || 'Someone',
      initials:     v.initials || deriveInitials(v.name),
      composing:    !!v.composing,
      composing_at: v.composing_at,
      last_seen_at: v.last_seen_at,
    })),
    window_seconds: VIEWER_WINDOW_S,
  };
  if (ticketUpdatedAt) body.ticket_updated_at = ticketUpdatedAt;
  return c.json(body);
});

// Explicit leave — called via fetch keepalive on unload so the chip clears
// immediately rather than ageing out.
presence.delete('/:entityType/:entityId', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const entityType = c.req.param('entityType');
  const entityId   = c.req.param('entityId');

  if (!KNOWN_ENTITY_TYPES.has(entityType)) return c.json({ error: 'Unknown entity_type' }, 400);
  if (!UUID_RE.test(entityId)) return c.json({ error: 'entity_id must be a UUID' }, 400);

  await sql`
    delete from presence
    where workspace_id = ${workspaceId} and entity_type = ${entityType}
      and entity_id = ${entityId} and user_id = ${userId}
  `;
  return c.body(null, 204);
});
