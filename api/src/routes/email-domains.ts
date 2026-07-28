// Workspace self-serve sender domains: a brand admin adds their own domain,
// gets the Postmark DKIM + Return-Path DNS records to publish, and the check
// endpoint (polled by the settings page, plus the daily cron sweep) flips it
// verified with no further action. Orchestration is shared with the god
// panel via lib/email-domains.ts.
//
// Authorization is API middleware: every handler requires a workspace ADMIN
// and scopes by c.get('workspaceId') — never a client-supplied id. There is
// no DB-level backstop (no RLS).

import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspaceAdmin } from '../lib/authz.js';
import { writeAudit } from '../middleware/platform-admin.js';
import { enforceRateLimit } from '../lib/rate-limit.js';
import { env } from '../lib/env.js';
import { getOutboundFrom } from '../lib/outbound-from.js';
import {
  isPostmarkAccountConfigured,
  PostmarkAccountError,
  PostmarkAccountNotConfiguredError,
} from '../lib/postmark-domains.js';
import {
  DomainSchema,
  DomainConflictError,
  deriveStatus,
  listEmailDomains,
  addEmailDomain,
  checkEmailDomain,
  removeEmailDomain,
  type EmailDomainRow,
} from '../lib/email-domains.js';

export const emailDomains = new Hono();

emailDomains.use('*', requireAuth);

const AddBody = z.object({ domain: DomainSchema }).strict();

function publicRow(d: EmailDomainRow) {
  return {
    id: d.id,
    domain: d.domain,
    status: deriveStatus(d),
    verified_at: d.verified_at,
    degraded_at: d.degraded_at,
    last_checked_at: d.last_checked_at,
    created_at: d.created_at,
    dns_setup: d.dns_records,
  };
}

// GET /api/v1/email-domains — domains + current sender identity. Pure DB
// (dns_setup comes from the snapshot column): safe for the page's poll-free
// initial render.
emailDomains.get('/', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;
  const workspaceId = c.get('workspaceId');

  const [rows, workspaceFrom] = await Promise.all([
    listEmailDomains(workspaceId),
    getOutboundFrom(workspaceId),
  ]);

  const platformFrom = env.POSTMARK_OUTBOUND_FROM || null;
  const senderIdentity = workspaceFrom
    ? { from_email: workspaceFrom.fromEmail, from_name: workspaceFrom.fromName, source: 'workspace' as const }
    : platformFrom
      ? { from_email: platformFrom, from_name: null, source: 'platform' as const }
      : { from_email: null, from_name: null, source: 'none' as const };

  return c.json({
    domains: rows.map(publicRow),
    sender_identity: senderIdentity,
    // Shown in the "Receiving replies" note: forwarding support@<domain>
    // to this address routes public mailbox mail into the workspace.
    inbound_address: env.POSTMARK_INBOUND_REPLY_ADDRESS || null,
    postmark_configured: isPostmarkAccountConfigured(),
  });
});

// POST /api/v1/email-domains — claim a domain, provision at Postmark, return
// the DNS records to publish.
emailDomains.post('/', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;
  const workspaceId = c.get('workspaceId');

  const limited = await enforceRateLimit(c, { name: 'email-domain-add', by: workspaceId, max: 5, windowSeconds: 3600 });
  if (limited) return limited;

  const body = await c.req.json().catch(() => null);
  const parsed = AddBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }

  // Same invariant the god route enforces: the system unrouted bucket never
  // gets a sender domain (a platform admin passes requireWorkspaceAdmin for
  // any workspace, so this surface must re-check).
  const sql = getDb();
  const [ws] = await sql<{ is_unrouted_bucket: boolean }[]>`
    select is_unrouted_bucket from workspaces where id = ${workspaceId}
  `;
  if (!ws) return c.json({ error: 'Workspace not found' }, 404);
  if (ws.is_unrouted_bucket) return c.json({ error: 'Cannot add domain to system workspace' }, 403);

  let result: Awaited<ReturnType<typeof addEmailDomain>>;
  try {
    result = await addEmailDomain(workspaceId, parsed.data.domain);
  } catch (err) {
    if (err instanceof DomainConflictError) {
      // Neutral copy: the unique index is GLOBAL (inbound routing keys on the
      // domain), so don't reveal whether/where it's held.
      return c.json({ error: 'This domain is not available.' }, 409);
    }
    throw err;
  }

  await writeAudit({
    workspaceId,
    actorUserId: c.get('userId'),
    action: 'email_domain.added',
    targetType: 'workspace',
    targetId: workspaceId,
    metadata: {
      domain: result.row.domain,
      domain_id: result.row.id,
      postmark_domain_id: result.row.postmark_domain_id,
      postmark_error: result.postmarkError,
    },
  });

  return c.json({
    domain: publicRow(result.row),
    postmark_configured: isPostmarkAccountConfigured(),
    postmark_error: result.postmarkError,
  }, 201);
});

// POST /api/v1/email-domains/:id/check — re-verify with Postmark. Called by
// the settings page's zero-click poll (~45s) and the manual "Check now"
// button; rate-limited per workspace so neither can hammer Postmark.
// `manual: true` (the button) additionally clears a send-rejection degrade —
// the automatic poll must not, or a persistent Postmark account issue would
// flap degrade/recover every 45s (see checkEmailDomain).
emailDomains.post('/:id/check', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;
  const workspaceId = c.get('workspaceId');

  const limited = await enforceRateLimit(c, { name: 'email-domain-check', by: workspaceId, max: 10, windowSeconds: 300 });
  if (limited) return limited;

  if (!isPostmarkAccountConfigured()) {
    return c.json({ error: 'Postmark Domains API is not configured' }, 503);
  }

  const body = await c.req.json().catch(() => null);
  const manual = body?.manual === true;

  let result: Awaited<ReturnType<typeof checkEmailDomain>>;
  try {
    result = await checkEmailDomain(workspaceId, c.req.param('id'), { clearSendRejected: manual });
  } catch (err) {
    if (err instanceof PostmarkAccountError) {
      return c.json({ error: err.message, postmark_status: err.httpStatus }, 502);
    }
    if (err instanceof PostmarkAccountNotConfiguredError) {
      return c.json({ error: err.message }, 503);
    }
    throw err;
  }
  if (!result) return c.json({ error: 'Domain not found' }, 404);

  if (result.becameVerified) {
    await writeAudit({
      workspaceId,
      actorUserId: c.get('userId'),
      action: 'email_domain.verified',
      targetType: 'workspace',
      targetId: workspaceId,
      metadata: { domain: result.row.domain, domain_id: result.row.id },
    });
  }

  return c.json({
    domain: publicRow(result.row),
    fully_verified: result.fullyVerified,
    dkim_verified: result.pmDomain.DKIMVerified,
    return_path_verified: result.pmDomain.ReturnPathDomainVerified,
  });
});

// DELETE /api/v1/email-domains/:id — offboard a sender domain (soft-delete;
// the domain string frees up for re-use).
emailDomains.delete('/:id', async (c) => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;
  const workspaceId = c.get('workspaceId');

  const result = await removeEmailDomain(workspaceId, c.req.param('id'));
  if (!result) return c.json({ error: 'Domain not found' }, 404);

  await writeAudit({
    workspaceId,
    actorUserId: c.get('userId'),
    action: 'email_domain.removed',
    targetType: 'workspace',
    targetId: workspaceId,
    metadata: { domain: result.row.domain, domain_id: result.row.id, postmark_delete_error: result.postmarkDeleteError },
  });

  return c.json({ ok: true, postmark_delete_error: result.postmarkDeleteError });
});
