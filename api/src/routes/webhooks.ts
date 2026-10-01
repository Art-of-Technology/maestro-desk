import { safeError } from '../lib/diagnostics.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { getDb } from '../lib/db.js';
import { PostmarkInbound, assertPostmarkAuth, parseTo } from '../lib/postmark.js';
import { processInboundEmail, resolveInboundWorkspace } from '../lib/inbound-email.js';
import { verifySlackSignature } from '../lib/slack-verify.js';
import { handleSlackEvent } from '../lib/slack-inbound.js';
import { PostmarkBounce, processBounceEvent, fromDomain } from '../lib/postmark-bounce.js';

export const webhooks = new Hono();

// POST /api/v1/webhooks/postmark/inbound
//
// Postmark POSTs an inbound email here. We:
//   1. Validate the webhook secret (HTTP Basic Auth header; see assertPostmarkAuth).
//   2. Parse the JSON payload with Zod.
//   3. Resolve the destination workspace from the To: domain — match
//      against workspace_email_domains, else fall back to the system
//      "unrouted" bucket so customer mail never silently drops.
//   4. Hand off to processInboundEmail (customer match + ticket + auto-triage).
//   5. Return 200 immediately so Postmark doesn't retry.
//
// Body limit: Postmark's inbound cap is 35 MB per message, which is ~47 MB as
// base64-in-JSON. 64 MB is a DoS guard only — a real message never hits it
// (a 413 would make Postmark retry for hours and then drop the mail; oversize
// FILES are skipped per-attachment in lib/message-attachments.ts instead).
const POSTMARK_INBOUND_MAX_BYTES = 64 * 1024 * 1024;
webhooks.post('/postmark/inbound', bodyLimit({ maxSize: POSTMARK_INBOUND_MAX_BYTES }), async (c) => {
  assertPostmarkAuth(c);

  const body = await c.req.json().catch(() => null);
  const parsed = PostmarkInbound.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: 'Invalid Postmark payload: ' + parsed.error.issues.map((i) => i.message).join('; '),
    });
  }
  const payload = parsed.data;

  try {
    const sql = getDb();
    const to = parseTo(payload);
    const resolution = await resolveInboundWorkspace({
      toDomain: to?.domain ?? null,
    });

    const result = await processInboundEmail({
      workspaceId: resolution.workspaceId,
      payload,
    });
    // Per-event audit row when we fell through to the unrouted bucket so
    // platform admins can find them in the god UI. Skipped for routed mail
    // (the ticket itself is the evidence; spamming audit_events for every
    // routed message would dwarf legitimate audit entries).
    if (!resolution.routed) {
      await sql`
        insert into audit_events (workspace_id, action, target_type, target_id, metadata)
        values (${resolution.workspaceId}, 'inbound.unrouted', 'ticket', ${result.ticket_id}, ${sql.json({
          to_email: to?.email ?? null,
          to_domain: to?.domain ?? null,
          from_email: payload.FromFull?.Email ?? payload.From,
          subject: payload.Subject,
          message_id: payload.MessageID,
        })})
      `;
    }

    // Outcome only; routing and customer identifiers stay out of diagnostics.
    if (result.deduped) {
      console.log('[postmark] inbound deduplicated');
    } else if (result.threaded) {
      console.log('[postmark] inbound threaded');
    } else {
      console.log('[postmark] inbound ticket created', { routed: resolution.routed });
    }
    return c.json({ ...result, routed: resolution.routed }, 200);
  } catch (err) {
    console.error('[postmark] processInboundEmail failed:', safeError(err));
    // 500 (not 400) so Postmark will retry — likely a transient DB issue,
    // not a malformed payload.
    throw new HTTPException(500, {
      message: err instanceof Error ? err.message : 'Inbound processing failed',
    });
  }
});

// POST /api/v1/webhooks/slack/events
//
// Slack POSTs Events API callbacks here. Two flavours:
//   1. type=url_verification — return the challenge string. Slack
//      sends this once when the URL is configured in the app
//      dashboard.
//   2. type=event_callback — wrapped event (message, etc). We
//      verify the HMAC signature against the workspace's
//      signing_secret (looked up via the team_id in the payload),
//      then hand off to handleSlackEvent.
//
// MUST return 200 quickly — Slack treats anything else as a
// retryable failure and will replay events up to 3 times.
webhooks.post('/slack/events', async (c) => {
  const rawBody = await c.req.text();
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new HTTPException(400, { message: 'Invalid JSON' });
  }

  // URL verification handshake. No signature required (Slack sends
  // this before the app is fully wired up).
  if (payload.type === 'url_verification') {
    return c.json({ challenge: payload.challenge });
  }

  if (payload.type !== 'event_callback') {
    // Other top-level types (app_rate_limited, etc) — ack and ignore.
    return c.json({ ok: true });
  }

  const teamId = payload.team_id;
  if (!teamId) return c.json({ error: 'Missing team_id' }, 400);

  // Pick the candidate integration(s) by team_id (stable per Slack workspace),
  // then verify the HMAC signature against the candidate's signing_secret.
  // Fast path: the row already tagged with this team_id → O(1) indexed read.
  // Cache miss (first event for this team, or the team changed): fall back to
  // the full active scan — same cost as before, but only on a miss — and
  // re-tag the matched row so subsequent events are O(1). team_id is only a
  // routing hint; the signature check below remains the real authority.
  const sql = getDb();
  type IntegrationRow = { workspace_id: string; signing_secret: string | null; bot_token: string | null };
  let candidates = await sql<IntegrationRow[]>`
    select workspace_id, signing_secret, bot_token
    from slack_integrations
    where team_id = ${teamId} and signing_secret is not null and active = true
  `;
  const needsBackfill = candidates.length === 0;
  if (needsBackfill) {
    candidates = await sql<IntegrationRow[]>`
      select workspace_id, signing_secret, bot_token
      from slack_integrations
      where signing_secret is not null and active = true
    `;
  }

  const signature = c.req.header('x-slack-signature') || null;
  const timestamp = c.req.header('x-slack-request-timestamp') || null;
  const verified = candidates.find((row) => {
    const r = verifySlackSignature({
      signingSecret: row.signing_secret as string,
      signature,
      timestamp,
      rawBody,
    });
    return r.ok;
  });
  if (!verified) {
    console.warn('[slack-events] signature did not match any workspace');
    throw new HTTPException(401, { message: 'Bad signature' });
  }

  // Self-healing backfill: tag (or re-tag) the matched row with this team_id so
  // future events hit the O(1) fast path. Covers both an untagged row and a
  // workspace that re-pointed to a different Slack team. Best-effort: the event
  // is already verified, so a tagging hiccup must not fail it (we'd just take
  // the fallback scan again next time).
  if (needsBackfill) {
    try {
      await sql`update slack_integrations set team_id = ${teamId} where workspace_id = ${verified.workspace_id}`;
    } catch (err) {
      console.warn('[slack-events] team_id backfill failed:', safeError(err));
    }
  }

  try {
    await handleSlackEvent({
      workspaceId: verified.workspace_id,
      botToken:    verified.bot_token,
      payload,
    });
  } catch (err) {
    console.error('[slack-events] handler failed:', safeError(err));
    // Still ack 200 so Slack doesn't retry on an internal bug; the
    // event is logged for follow-up.
  }
  return c.json({ ok: true });
});

// POST /api/v1/webhooks/postmark/bounce
//
// Postmark POSTs here on Bounce and SpamComplaint events. Pointed at
// the same shared-secret URL the inbound webhook uses (Postmark lets
// you configure each event-type endpoint independently). We always
// ack 200 — Postmark retries on non-2xx, and a single bounce event
// failing to land in our DB shouldn't pile up retries forever. Real
// failures get logged.
webhooks.post('/postmark/bounce', async (c) => {
  assertPostmarkAuth(c);

  const body = await c.req.json().catch(() => null);
  const parsed = PostmarkBounce.safeParse(body);
  if (!parsed.success) {
    // Bad shape from Postmark is extremely unlikely — log and 200 so
    // they don't replay. If we ever start seeing these in logs,
    // tighten the schema.
    console.warn('[postmark-bounce] invalid payload');
    return c.json({ ok: false, error: 'Invalid payload' }, 200);
  }

  // processBounceEvent reads/writes Neon via getDb() internally (Step 3).
  const result = await processBounceEvent({
    payload:    parsed.data,
    fromDomain: fromDomain(parsed.data),
  });

  if (!result.ok) {
    console.warn('[postmark-bounce] processing failed');
    return c.json({ ok: false, error: result.error }, 200);
  }

  console.log('[postmark-bounce] processed', { matched: result.matched });
  return c.json({ ok: true, matched: result.matched, state: result.state });
});
