import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspaceAdmin } from '../lib/authz.js';
import { writeAudit } from '../middleware/platform-admin.js';
import { getDb } from '../lib/db.js';
import { nextDisplayId } from '../lib/display-id.js';

// Migration to Neon — Step 3. Reads are member-level; writes require a
// workspace ADMIN. Every query is workspace-scoped via c.get('workspaceId')
// (never a client-supplied id) — there is no DB-level backstop (no RLS).
//
// Channels carry the inbound ticket defaults: the Postmark webhook matches
// an email's To: address to a channel and applies its default_priority_key /
// default_category_key to the ticket it creates (lib/inbound-email.ts), so
// complaint@brand.com can land more urgent than support@brand.com.
// default_assigned_user_id is stored and shown but NOT applied at inbound
// yet (deliberate — auto-assignment interacts with push/SLA and ships
// separately).
export const channels = new Hono();

channels.use('*', requireAuth);

const CHANNEL_COLS = `
  ch.id, ch.display_id, ch.name, ch.type, ch.address, ch.status,
  ch.default_category_key, ch.default_priority_key, ch.signature, ch.volume_30d
`;

function publicRow(row: any) {
  return {
    id:                   row.id,
    display_id:           row.display_id,
    name:                 row.name,
    type:                 row.type,
    address:              row.address,
    status:               row.status,
    default_category_key: row.default_category_key,
    default_priority_key: row.default_priority_key,
    default_agent_name:   row.default_agent_name ?? null,
    signature:            row.signature || '',
    volume_30d:           row.volume_30d || 0,
  };
}

// List channels with the default-assigned user's name joined so the SPA can
// show "default agent" without a second round-trip.
channels.get('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const rows = await sql`
    select ${sql.unsafe(CHANNEL_COLS)}, u.name as default_agent_name
    from channels ch
    left join users u on u.id = ch.default_assigned_user_id
    where ch.workspace_id = ${workspaceId} and ch.deleted_at is null
    order by ch.display_id asc
  `;
  return c.json({ channels: rows.map(publicRow) });
});

const ChannelBody = z.object({
  name:                     z.string().trim().min(1).max(200),
  type:                     z.enum(['email', 'webform', 'chat', 'api']),
  address:                  z.string().trim().max(320).nullable().optional(),
  status:                   z.enum(['active', 'inactive']).optional(),
  default_category_key:     z.string().max(100).nullable().optional(),
  default_priority_key:     z.string().max(100).nullable().optional(),
  default_assigned_user_id: z.string().uuid().nullable().optional(),
  signature:                z.string().max(2000).nullable().optional(),
}).strict();

const PatchChannel = ChannelBody.partial().strict();

// Pre-validate lookup references so a bad key is a clean 400, not a 23503 →
// 500. All three lookups are workspace-scoped (composite FKs / membership).
async function validateRefs(
  workspaceId: string,
  input: Partial<z.infer<typeof ChannelBody>>,
): Promise<string | null> {
  const sql = getDb();
  if (input.default_priority_key != null) {
    const [p] = await sql`
      select 1 from ticket_priorities
      where workspace_id = ${workspaceId} and key = ${input.default_priority_key}
    `;
    if (!p) return 'Unknown priority key';
  }
  if (input.default_category_key != null) {
    const [cat] = await sql`
      select 1 from ticket_categories
      where workspace_id = ${workspaceId} and key = ${input.default_category_key}
    `;
    if (!cat) return 'Unknown category key';
  }
  if (input.default_assigned_user_id != null) {
    const [m] = await sql`
      select 1 from workspace_members
      where workspace_id = ${workspaceId} and user_id = ${input.default_assigned_user_id}
        and active = true
    `;
    if (!m) return 'Default agent is not an active member of this workspace';
  }
  return null;
}

// POST /api/v1/channels — create. Admin-only.
channels.post('/', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;
  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const body = await c.req.json().catch(() => null);
  const parsed = ChannelBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  const refError = await validateRefs(workspaceId, input);
  if (refError) return c.json({ error: refError }, 400);

  const displayId = await nextDisplayId(sql, workspaceId, 'channel');
  const [row] = await sql`
    insert into channels
      (workspace_id, display_id, name, type, address, status,
       default_category_key, default_priority_key, default_assigned_user_id, signature)
    values
      (${workspaceId}, ${displayId}, ${input.name}, ${input.type}, ${input.address ?? null},
       ${input.status ?? 'active'}, ${input.default_category_key ?? null},
       ${input.default_priority_key ?? null}, ${input.default_assigned_user_id ?? null},
       ${input.signature ?? null})
    returning id, display_id, name, type, address, status,
              default_category_key, default_priority_key, signature, volume_30d,
              (select name from users where id = channels.default_assigned_user_id) as default_agent_name
  `;

  await writeAudit({
    workspaceId,
    actorUserId: c.get('userId'),
    action: 'channel.created',
    targetType: 'channel',
    targetId: row.id,
    metadata: { display_id: row.display_id, name: row.name, type: row.type, address: row.address },
  });
  return c.json({ channel: publicRow(row) }, 201);
});

// PATCH /api/v1/channels/:id — partial update. Admin-only.
channels.patch('/:id', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = PatchChannel.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }
  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  const refError = await validateRefs(workspaceId, parsed.data);
  if (refError) return c.json({ error: refError }, 400);

  const [row] = await sql`
    update channels set ${sql(parsed.data)}
    where id = ${id} and workspace_id = ${workspaceId} and deleted_at is null
    returning id, display_id, name, type, address, status,
              default_category_key, default_priority_key, signature, volume_30d,
              (select name from users where id = channels.default_assigned_user_id) as default_agent_name
  `;
  if (!row) return c.json({ error: 'Channel not found' }, 404);

  await writeAudit({
    workspaceId,
    actorUserId: c.get('userId'),
    action: 'channel.updated',
    targetType: 'channel',
    targetId: row.id,
    metadata: { display_id: row.display_id, fields: Object.keys(parsed.data) },
  });
  return c.json({ channel: publicRow(row) });
});

// DELETE /api/v1/channels/:id — SOFT delete. inbox_messages.channel_id is
// NOT NULL with ON DELETE CASCADE, so a hard delete would wipe the channel's
// inbox audit trail. Soft-deleted channels stop matching inbound (the
// resolver filters deleted_at) and disappear from the list; display_ids are
// never reused (atomic allocator) so the unique constraint stays safe.
channels.delete('/:id', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  const [row] = await sql`
    update channels set deleted_at = now(), status = 'inactive'
    where id = ${id} and workspace_id = ${workspaceId} and deleted_at is null
    returning id, display_id, name
  `;
  if (!row) return c.json({ error: 'Channel not found' }, 404);

  await writeAudit({
    workspaceId,
    actorUserId: c.get('userId'),
    action: 'channel.deleted',
    targetType: 'channel',
    targetId: row.id,
    metadata: { display_id: row.display_id, name: row.name },
  });
  return new Response(null, { status: 204 });
});
