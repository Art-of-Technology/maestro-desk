import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { supabaseAdmin } from '../lib/supabase.ts';
import { PostmarkInbound, assertPostmarkAuth, parseTo } from '../lib/postmark.ts';
import { processInboundEmail, resolveInboundWorkspace } from '../lib/inbound-email.ts';
import { verifySlackSignature } from '../lib/slack-verify.ts';
import { handleSlackEvent } from '../lib/slack-inbound.ts';

export const webhooks = new Hono();

// POST /api/v1/webhooks/postmark/inbound
//
// Postmark POSTs an inbound email here. We:
//   1. Validate the webhook secret (in the URL query string).
//   2. Parse the JSON payload with Zod.
//   3. Resolve the destination workspace from the To: domain — match
//      against workspace_email_domains, else fall back to the system
//      "unrouted" bucket so customer mail never silently drops.
//   4. Hand off to processInboundEmail (customer match + ticket + auto-triage).
//   5. Return 200 immediately so Postmark doesn't retry.
webhooks.post('/postmark/inbound', async (c) => {
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
    const to = parseTo(payload);
    const resolution = await resolveInboundWorkspace({
      sb: supabaseAdmin,
      toDomain: to?.domain ?? null,
    });

    const result = await processInboundEmail({
      sb: supabaseAdmin,
      workspaceId: resolution.workspaceId,
      payload,
    });
    // Per-event audit row when we fell through to the unrouted bucket so
    // platform admins can find them in the god UI. Skipped for routed mail
    // (the ticket itself is the evidence; spamming audit_events for every
    // routed message would dwarf legitimate audit entries).
    if (!resolution.routed) {
      await supabaseAdmin.from('audit_events').insert({
        workspace_id: resolution.workspaceId,
        action: 'inbound.unrouted',
        target_type: 'ticket',
        target_id: result.ticket_id,
        metadata: {
          to_email: to?.email ?? null,
          to_domain: to?.domain ?? null,
          from_email: payload.FromFull?.Email ?? payload.From,
          subject: payload.Subject,
          message_id: payload.MessageID,
        },
      });
    }

    // Log lines diverge by dedup / threaded / new-ticket so the dev tail
    // can see at a glance whether a retry hit existing state. Routing info
    // is included in every variant.
    const routing = resolution.routed ? `matched ${resolution.matchedDomain}` : 'UNROUTED';
    const dest = `workspace ${resolution.workspaceId} (${routing})`;
    if (result.deduped) {
      console.log(`[postmark] inbound to ${to?.email ?? '(unknown)'} → ${dest} → DEDUPED to existing ticket ${result.ticket_display_id}`);
    } else if (result.threaded) {
      console.log(`[postmark] inbound to ${to?.email ?? '(unknown)'} → ${dest} → THREADED reply on ticket ${result.ticket_display_id}`);
    } else {
      console.log(
        `[postmark] inbound to ${to?.email ?? '(unknown)'} → ${dest} ` +
          `→ ticket ${result.ticket_display_id} (new_customer=${result.is_new_customer}, auto_triage=${result.auto_triage_queued})`,
      );
    }
    return c.json({ ...result, routed: resolution.routed }, 200);
  } catch (err) {
    console.error('[postmark] processInboundEmail failed:', err);
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

  // Lookup the integration row by team_id. The team_id is stable per
  // Slack workspace, so we use it as the join key into our
  // slack_integrations table. We don't store team_id explicitly yet —
  // the migration adds it implicitly via the first chat.postMessage
  // response. Until that happens, scan by signing_secret presence and
  // attempt to verify against each.
  //
  // For now: pick the integration whose signing_secret verifies. This
  // is O(workspaces-with-slack-configured); fine at hundreds, would
  // need a team_id column for tens of thousands.
  const { data: candidates } = await supabaseAdmin
    .from('slack_integrations')
    .select('workspace_id, signing_secret, bot_token, active')
    .not('signing_secret', 'is', null)
    .eq('active', true);

  const signature = c.req.header('x-slack-signature') || null;
  const timestamp = c.req.header('x-slack-request-timestamp') || null;
  const verified = (candidates || []).find((row) => {
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

  try {
    await handleSlackEvent({
      sb:          supabaseAdmin,
      workspaceId: verified.workspace_id,
      botToken:    verified.bot_token,
      payload,
    });
  } catch (err) {
    console.error('[slack-events] handler failed:', err);
    // Still ack 200 so Slack doesn't retry on an internal bug; the
    // event is logged for follow-up.
  }
  return c.json({ ok: true });
});
