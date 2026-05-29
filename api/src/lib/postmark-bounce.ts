// Postmark bounce + spam-complaint event handler. The two RecordTypes
// land at the same webhook in Postmark's config — they share a payload
// shape (the bounce one is a superset). We branch on RecordType + Type
// to map onto a small set of states the SPA cares about:
//
//   HardBounce / DnsError / Blocked / NoEmail   → state = 'hard'
//   SpamComplaint / SpamNotification            → state = 'spam'
//   SoftBounce / Transient / DMARCPolicy / *    → state = 'soft'
//
// We denormalise the summary onto customers — single row update per
// event, with email_bounce_count incremented atomically via the .rpc()
// pattern. History (full per-event audit) is deferred until a
// follow-up; if you need it for compliance, run from Postmark's own
// event log in the dashboard.

import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';

export const PostmarkBounce = z
  .object({
    RecordType:  z.enum(['Bounce', 'SpamComplaint']),
    Type:        z.string(),       // HardBounce | SoftBounce | Transient | SpamNotification | …
    Email:       z.string(),       // the recipient (the customer)
    From:        z.string().optional(),
    BouncedAt:   z.string().optional(),
    MessageID:   z.string().optional(),
    Description: z.string().optional(),
    Details:     z.string().optional(),
    Inactive:    z.boolean().optional(),
  })
  .passthrough();

export type PostmarkBounce = z.infer<typeof PostmarkBounce>;

export type BounceState = 'soft' | 'hard' | 'spam';

const HARD_TYPES = new Set([
  'HardBounce',
  'DnsError',
  'Blocked',
  'NoEmail',
  'SMTPApiError',
]);

export function classifyBounce(payload: PostmarkBounce): BounceState {
  if (payload.RecordType === 'SpamComplaint' || payload.Type === 'SpamNotification') {
    return 'spam';
  }
  if (HARD_TYPES.has(payload.Type)) {
    return 'hard';
  }
  return 'soft';
}

export interface BounceProcessResult {
  ok:           true;
  matched:      boolean;     // did we find a customer to update?
  workspaceId:  string;
  customerId:   string | null;
  state:        BounceState;
}

/**
 * Apply a bounce event to the matching customer. Workspace is resolved
 * from the From-address domain (that's our sending address — its
 * domain identifies the workspace via workspace_email_domains).
 * Customer is matched by the Email field on case-insensitive equality.
 *
 * Returns matched=false when:
 *   - No workspace owns the From domain (event ignored, unlikely in
 *     practice because we only send from configured domains)
 *   - No customer in that workspace has the recipient email (likely
 *     when an agent emailed a non-customer address — out of scope to
 *     create a customer-shaped row for a bouncer)
 */
export async function processBounceEvent(args: {
  sb:        SupabaseClient;
  payload:   PostmarkBounce;
  fromDomain: string | null;
}): Promise<BounceProcessResult | { ok: false; error: string }> {
  const { sb, payload, fromDomain } = args;
  const state = classifyBounce(payload);
  const recipient = payload.Email.trim().toLowerCase();
  if (!recipient) return { ok: false, error: 'Missing recipient email' };

  // Resolve workspace from sending domain. Bounces for non-configured
  // sending domains shouldn't happen, but if they do we bail rather
  // than write into the unrouted bucket — that bucket is for inbound
  // misses, not outbound bookkeeping.
  if (!fromDomain) return { ok: false, error: 'Missing From domain' };
  const { data: domainRow, error: domainErr } = await sb
    .from('workspace_email_domains')
    .select('workspace_id')
    .eq('domain', fromDomain)
    .is('deleted_at', null)
    .maybeSingle();
  if (domainErr) return { ok: false, error: `Domain lookup: ${domainErr.message}` };
  if (!domainRow) return { ok: false, error: `Unknown From domain: ${fromDomain}` };
  const workspaceId = domainRow.workspace_id as string;

  // Find the customer in this workspace by email.
  const { data: customer, error: cErr } = await sb
    .from('customers')
    .select('id, email_bounce_count')
    .eq('workspace_id', workspaceId)
    .ilike('email', recipient)
    .is('deleted_at', null)
    .maybeSingle();
  if (cErr) return { ok: false, error: `Customer lookup: ${cErr.message}` };
  if (!customer) {
    return { ok: true, matched: false, workspaceId, customerId: null, state };
  }

  // Update the bounce summary. We don't downgrade — if a customer
  // already hit a hard bounce and a later soft event arrives, leave
  // state='hard' rather than reverting (Postmark replays in order
  // are not guaranteed, and "once undeliverable, stay undeliverable"
  // is the safer default).
  const nextCount = (customer.email_bounce_count || 0) + 1;
  const updates: Record<string, unknown> = {
    email_last_bounce_type: payload.Type,
    email_last_bounce_at:   payload.BouncedAt || new Date().toISOString(),
    email_bounce_count:     nextCount,
  };
  // Only escalate state, never downgrade.
  const rank = (s: string) => ({ none: 0, soft: 1, hard: 2, spam: 2 }[s] ?? 0);
  if (rank(state) >= rank((customer as any).email_bounce_state || 'none')) {
    updates.email_bounce_state = state;
  }
  const { error: upErr } = await sb
    .from('customers')
    .update(updates)
    .eq('id', customer.id);
  if (upErr) return { ok: false, error: `Update failed: ${upErr.message}` };

  return { ok: true, matched: true, workspaceId, customerId: customer.id, state };
}

/**
 * Extract the From-address's domain. Postmark's From is a plain
 * address string (no display name on this payload), so we just split
 * on @.
 */
export function fromDomain(payload: PostmarkBounce): string | null {
  const from = payload.From?.trim().toLowerCase();
  if (!from) return null;
  const at = from.lastIndexOf('@');
  if (at < 0) return null;
  return from.slice(at + 1) || null;
}
