import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../lib/db.js';
import { nextDisplayId } from '../lib/display-id.js';
import { workerFetch, workerMaestroConfigured, MaestroError, str } from '../lib/maestro.js';
import { agentBrandWorkspaceId } from '../lib/maestro-workspace.js';
import { requireWorkspaceAdmin, requireDeletePermission } from '../lib/authz.js';
import { eraseCustomer } from '../lib/gdpr-erasure.js';
import { exportCustomer } from '../lib/gdpr-export.js';
import { writeAudit } from '../middleware/platform-admin.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const eraseBody = z.object({ reason: z.string().trim().max(500).optional() });

// Migration to Neon — Step 3. Member-level, workspace-scoped via getDb().
export const customers = new Hono();

customers.use('*', requireAuth);

// Create (or find) a local customer from a live Maestro player — so an agent can
// proactively open a conversation with someone who has NEVER contacted support
// (and therefore has no local record yet). The caller passes one lookup key; we
// re-fetch the authoritative player with the app token (never trust client PII),
// upsert by email within the workspace, and return the customer id. The SPA then
// opens a ticket against it via the normal POST /api/v1/tickets path.
customers.post('/from-player', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  if (!workerMaestroConfigured()) return c.json({ error: 'Player lookup is not configured.' }, 503);
  const brandId = c.req.header('X-Brand-Id');
  if (!brandId) return c.json({ error: 'X-Brand-Id header required.' }, 400);
  // Per-agent brand gate + tenant coherence (advisory #10): the re-fetch uses the
  // app token, so confirm this agent belongs to the brand AND that the brand's
  // workspace is the one we're about to write the player's PII into. Without the
  // second check an agent who belongs to workspace A *and* has access to a
  // different brand B could pull brand B's player PII into workspace A.
  const brandWorkspaceId = await agentBrandWorkspaceId(c.get('userId'), brandId);
  if (!brandWorkspaceId) {
    return c.json({ error: 'You do not have access to this brand.' }, 403);
  }
  if (brandWorkspaceId !== workspaceId) {
    return c.json({ error: 'The selected brand does not match this workspace.' }, 400);
  }

  const body = (await c.req.json().catch(() => null)) as
    | { email?: string; memberId?: string; maestroUserId?: string }
    | null;
  const key = body?.email
    ? { email: body.email }
    : body?.memberId
      ? { memberId: body.memberId }
      : body?.maestroUserId
        ? { maestroUserId: body.maestroUserId }
        : null;
  if (!key) return c.json({ error: 'Provide one of email, memberId or maestroUserId.' }, 400);

  let m: Record<string, unknown>;
  try {
    m = await workerFetch<Record<string, unknown>>('/api/v1/proxy/member/lookup', { brandId, query: key });
  } catch (err) {
    // Distinguish failure modes so the agent gets an actionable message rather
    // than a blanket 502: auth (bad/expired app token or brand not granted) vs
    // unreachable gateway (status 0) vs any other upstream error.
    if (err instanceof MaestroError) {
      if (err.status === 401 || err.status === 403) {
        return c.json({ error: 'Maestro rejected the lookup (token or brand access).' }, 502);
      }
      if (err.status === 0) {
        return c.json({ error: 'Could not reach the Maestro gateway.' }, 502);
      }
      return c.json({ error: err.message || 'Maestro lookup failed.' }, 502);
    }
    return c.json({ error: 'Could not reach Maestro to resolve the player.' }, 502);
  }
  if (!m || m.success === false || m.errorCode === 101) {
    return c.json({ error: 'No matching player found.' }, 404);
  }

  const email = str(m.email);
  if (!email) return c.json({ error: 'Player has no email on file; cannot start a conversation.' }, 422);

  const existing = await sql<{ id: string }[]>`
    select id from customers
    where workspace_id = ${workspaceId} and email = ${email} and deleted_at is null
    limit 1
  `;
  if (existing.length) return c.json({ customer: { id: existing[0].id }, created: false });

  const displayId = await nextDisplayId(sql, workspaceId, 'customer');
  const [created] = await sql<{ id: string }[]>`
    insert into customers
      (workspace_id, display_id, first_name, last_name, username, email, mobile, vip_tier, jurisdiction, kyc_status)
    values
      (${workspaceId}, ${displayId}, ${str(m.firstName)}, ${str(m.lastName)}, ${str(m.username)},
       ${email}, ${str(m.mobile)}, ${str(m.vipLevel)}, ${str(m.country)}, ${str(m.kycStatus)})
    returning id
  `;
  return c.json({ customer: { id: created.id }, created: true }, 201);
});

// List customers in the active workspace. Returns the raw DB shape; the SPA
// remaps to its camelCase view model. No pagination yet (small in v1).
customers.get('/', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const rows = await sql`
    select id, display_id, first_name, last_name, username, email, mobile, brand, vip_tier,
           jurisdiction, consent, kyc_status, since, backoffice_url, erased_at, created_at,
           email_bounce_state, email_last_bounce_type, email_last_bounce_at, email_bounce_count
    from customers
    where workspace_id = ${workspaceId} and deleted_at is null
    order by display_id asc
  `;
  return c.json({ customers: rows });
});

// ─── Customer notes ─────────────────────────────────────────────────────────
// First real persistence for customer_notes (until Phase 2 the SPA kept notes
// in memory and they vanished on refresh). List + create are member-level —
// any agent shares context; delete is gated by the can_delete capability.

// GET /notes — every note in the workspace in one call (the SPA groups them
// by customer at bootstrap; no per-customer N+1).
customers.get('/notes', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');

  const rows = await sql`
    select n.id, n.customer_id, n.author_user_id, u.name as author_name,
           n.text, n.created_at
    from customer_notes n
    left join users u on u.id = n.author_user_id
    where n.workspace_id = ${workspaceId}
    order by n.created_at desc
  `;
  return c.json({ notes: rows });
});

const NoteBody = z.object({ text: z.string().trim().min(1).max(4000) });

// POST /:id/notes — add an internal note to a customer. Author is the caller
// (stamped from the session, never trusted from the client).
customers.post('/:id/notes', async (c) => {
  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const customerId = c.req.param('id');
  if (!UUID_RE.test(customerId)) return c.json({ error: 'Customer not found' }, 404);

  const raw = await c.req.json().catch(() => null);
  const parsed = NoteBody.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);

  const [cust] = await sql`
    select 1 from customers
    where id = ${customerId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!cust) return c.json({ error: 'Customer not found' }, 404);

  const [note] = await sql`
    insert into customer_notes (workspace_id, customer_id, author_user_id, text)
    values (${workspaceId}, ${customerId}, ${userId}, ${parsed.data.text})
    returning id, customer_id, author_user_id, text, created_at
  `;
  const [u] = await sql<{ name: string | null }[]>`select name from users where id = ${userId}`;
  return c.json({ note: { ...note, author_name: u?.name ?? null } }, 201);
});

// DELETE /:id/notes/:noteId — remove a note. HARD delete: the table has no
// deleted_at (GDPR erasure already hard-deletes rows here) and the audit row
// below is the durable trail, preview included.
customers.delete('/:id/notes/:noteId', async (c) => {
  const denied = await requireDeletePermission(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const customerId = c.req.param('id');
  const noteId = c.req.param('noteId');
  if (!UUID_RE.test(customerId) || !UUID_RE.test(noteId)) return c.json({ error: 'Note not found' }, 404);

  const [row] = await sql<{ id: string; author_user_id: string | null; text: string; created_at: string }[]>`
    delete from customer_notes
    where id = ${noteId} and workspace_id = ${workspaceId} and customer_id = ${customerId}
    returning id, author_user_id, text, created_at
  `;
  if (!row) return c.json({ error: 'Note not found' }, 404);

  await writeAudit({
    workspaceId,
    actorUserId: c.get('userId'),
    action: 'customer_note.deleted',
    targetType: 'customer_note',
    targetId: row.id,
    metadata: {
      customer_id: customerId,
      author_user_id: row.author_user_id,
      created_at: row.created_at,
      text_preview: String(row.text || '').slice(0, 120),
    },
  });
  return new Response(null, { status: 204 });
});

// ─── DELETE /:id — soft-delete a customer profile ───────────────────────────
// Gated by the can_delete capability. Refused while the customer has any
// live ticket history — merge into another profile (or GDPR-erase) instead,
// so tickets can never lose their customer by accident. Soft delete: tickets
// and gdpr_erasures reference customers with no ON DELETE, and the partial
// unique index on (workspace_id, email) where deleted_at is null frees the
// address for reuse automatically.
customers.delete('/:id', async (c) => {
  const denied = await requireDeletePermission(c);
  if (denied) return denied;

  const sql = getDb();
  const workspaceId = c.get('workspaceId');
  const customerId = c.req.param('id');
  if (!UUID_RE.test(customerId)) return c.json({ error: 'Customer not found' }, 404);

  const [cust] = await sql<{ id: string; display_id: string; email: string | null; first_name: string | null; last_name: string | null }[]>`
    select id, display_id, email, first_name, last_name
    from customers
    where id = ${customerId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!cust) return c.json({ error: 'Customer not found' }, 404);

  const [t] = await sql`
    select 1 from tickets
    where workspace_id = ${workspaceId} and customer_id = ${customerId} and deleted_at is null
    limit 1
  `;
  if (t) {
    return c.json({ error: 'This customer has ticket history — merge them into another profile instead', code: 'has_tickets' }, 409);
  }

  await sql`
    update customers set deleted_at = now()
    where id = ${customerId} and workspace_id = ${workspaceId} and deleted_at is null
  `;

  await writeAudit({
    workspaceId,
    actorUserId: c.get('userId'),
    action: 'customer.deleted',
    targetType: 'customer',
    targetId: cust.id,
    metadata: {
      display_id: cust.display_id,
      email: cust.email,
      name: [cust.first_name, cust.last_name].filter(Boolean).join(' ') || null,
    },
  });
  // Known accepted limit: customers have no sync endpoint, so OTHER open tabs
  // keep the row until reload — true of every customer mutation today. The
  // acting tab splices locally on the 204.
  return new Response(null, { status: 204 });
});

// GET /:id/export — GDPR right-of-access / portability (Art. 15 / 20). Admin-only;
// returns the customer's full personal-data bundle as a downloadable JSON file.
customers.get('/:id/export', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const customerId = c.req.param('id');
  if (!UUID_RE.test(customerId)) return c.json({ error: 'Customer not found' }, 404);

  const bundle = await exportCustomer({ workspaceId, customerId });
  if (!bundle) return c.json({ error: 'Customer not found' }, 404);

  // Already erased → there's no personal data left to hand out. Signal it
  // distinctly instead of returning a mostly-null skeleton with 200.
  if (bundle.erased) {
    return c.json({ error: 'This customer\'s personal data has been erased', erased_at: bundle.customer.erased_at }, 410);
  }

  // Exporting everything we hold about a person is a sensitive read — log it.
  await writeAudit({
    workspaceId,
    actorUserId: userId,
    action: 'customer.exported',
    targetType: 'customer',
    targetId: customerId,
    metadata: { tickets: bundle.tickets.length, notes: bundle.notes.length, inbox_messages: bundle.inbox_messages.length },
  });

  // Sanitise the filename — display_id is workspace-controlled, so strip
  // anything outside a safe set before it lands in the header (no quote/CRLF
  // breakout of the Content-Disposition value).
  const safeId = String(bundle.customer.display_id ?? customerId).replace(/[^A-Za-z0-9._-]/g, '_');
  c.header('Content-Disposition', `attachment; filename="customer-${safeId}-export.json"`);
  return c.json(bundle);
});

// POST /:id/erase — GDPR right-to-erasure for a customer. Admin-only (the brand
// owner handles erasure requests; platform admins too via requireWorkspaceAdmin).
// Nulls/redacts the customer's PII across all surfaces + writes the audit row.
customers.post('/:id/erase', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;

  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const customerId = c.req.param('id');
  if (!UUID_RE.test(customerId)) return c.json({ error: 'Customer not found' }, 404);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = eraseBody.safeParse(raw ?? {});
  if (!parsed.success) return c.json({ error: 'Invalid request body' }, 400);
  const reason = parsed.data.reason || null;

  const result = await eraseCustomer({ workspaceId, customerId, requestedByUserId: userId, reason });
  if (!result) return c.json({ error: 'Customer not found' }, 404);

  // Only audit a real erasure, not an idempotent re-request on an already-erased
  // customer (no new gdpr_erasures row was written either).
  if (!result.alreadyErased) {
    await writeAudit({
      workspaceId,
      actorUserId: userId,
      action: 'customer.erased',
      targetType: 'customer',
      targetId: customerId,
      metadata: {
        fields_erased: result.fieldsErased,
        tickets_affected: result.ticketsAffected,
        notes_deleted: result.notesDeleted,
        messages_redacted: result.messagesRedacted,
        inbox_redacted: result.inboxRedacted,
        attachments_deleted: result.attachmentsDeleted,
        reason,
      },
    });
  }

  return c.json(result);
});
