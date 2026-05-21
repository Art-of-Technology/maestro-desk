import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { supabaseAdmin } from '../lib/supabase.ts';
import { PostmarkInbound, assertPostmarkAuth } from '../lib/postmark.ts';
import { processInboundEmail } from '../lib/inbound-email.ts';

export const webhooks = new Hono();

// For v1, all inbound email lands in the demo workspace — we have one Postmark
// inbound stream and no email→workspace routing yet. Real multi-tenancy comes
// later (Postmark per-workspace, or per-workspace subdomains routing to one
// stream with workspace identified by the To address).
const DEMO_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

// POST /api/v1/webhooks/postmark/inbound
//
// Postmark POSTs an inbound email here. We:
//   1. Basic-Auth-check the request (credentials in the webhook URL).
//   2. Parse the JSON payload with Zod (rejects malformed).
//   3. Hand off to processInboundEmail (customer match + ticket + auto-triage).
//   4. Return 200 immediately so Postmark doesn't retry.
//
// Auto-triage runs fire-and-forget in the background — see inbound-email.ts.
webhooks.post('/postmark/inbound', async (c) => {
  assertPostmarkAuth(c);

  const body = await c.req.json().catch(() => null);
  const parsed = PostmarkInbound.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: 'Invalid Postmark payload: ' + parsed.error.issues.map((i) => i.message).join('; '),
    });
  }

  try {
    const result = await processInboundEmail({
      sb: supabaseAdmin,
      workspaceId: DEMO_WORKSPACE_ID,
      payload: parsed.data,
    });
    // Log so the dev sees what happened in the bun dev window.
    console.log(
      `[postmark] inbound from ${parsed.data.From} → ticket ${result.ticket_display_id} ` +
        `(new_customer=${result.is_new_customer}, auto_triage=${result.auto_triage_queued})`,
    );
    return c.json(result, 200);
  } catch (err) {
    console.error('[postmark] processInboundEmail failed:', err);
    // We return 500 (not 400) so Postmark will retry — this is likely a
    // transient DB / network issue, not a malformed payload.
    throw new HTTPException(500, {
      message: err instanceof Error ? err.message : 'Inbound processing failed',
    });
  }
});
