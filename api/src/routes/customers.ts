import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../lib/db.js';
import { nextDisplayId } from '../lib/display-id.js';
import { workerFetch, workerMaestroConfigured, MaestroError, str } from '../lib/maestro.js';
import { agentCanAccessBrand } from '../lib/maestro-workspace.js';
import { requireWorkspaceAdmin } from '../lib/authz.js';
import { eraseCustomer } from '../lib/gdpr-erasure.js';
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
  // Same per-agent brand gate as the lookup route: the re-fetch uses the app
  // token, so confirm this agent belongs to the brand before resolving anyone.
  if (!(await agentCanAccessBrand(c.get('userId'), brandId))) {
    return c.json({ error: 'You do not have access to this brand.' }, 403);
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
        reason,
      },
    });
  }

  return c.json(result);
});
