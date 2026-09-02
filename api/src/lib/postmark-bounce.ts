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
import { getDb } from './db.js';
import { resolveCustomerByContact } from './customer-contacts.js';

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
  payload:   PostmarkBounce;
  fromDomain: string | null;
}): Promise<BounceProcessResult | { ok: false; error: string }> {
  // Migration to Neon — Step 3. Reads/writes go through getDb() raw SQL so
  // the bounce state stays consistent with the Neon-backed customers route +
  // suppression list (which read it).
  const sql = getDb();
  const { payload, fromDomain } = args;
  const state = classifyBounce(payload);
  const recipient = payload.Email.trim().toLowerCase();
  if (!recipient) return { ok: false, error: 'Missing recipient email' };

  // Resolve workspace from the sending domain. Bail (don't write the unrouted
  // bucket) for non-configured sending domains — that bucket is for inbound
  // misses, not outbound bookkeeping.
  if (!fromDomain) return { ok: false, error: 'Missing From domain' };

  // DB errors are caught and returned as { ok: false } (not thrown): this
  // webhook must always 200 so Postmark doesn't retry-storm on a transient DB
  // failure. The route logs the { ok: false } error and acks 200.
  try {
    // verified_at gate — same reasoning as inbound routing: an unverified
    // self-serve claim must not attribute another brand's bounces.
    const [domainRow] = await sql<{ workspace_id: string }[]>`
      select workspace_id from workspace_email_domains
      where domain = ${fromDomain} and verified_at is not null and deleted_at is null
    `;
    if (!domainRow) return { ok: false, error: `Unknown From domain: ${fromDomain}` };
    const workspaceId = domainRow.workspace_id;

    // Find the profile holding this address — primary OR secondary (Phase 4
    // contacts model; the bounce belongs to whichever profile holds the row,
    // no merge hop). `heal` backfills a legacy scalar-only profile so the
    // per-address write below has a row to land on.
    const holder = await resolveCustomerByContact(sql, workspaceId, 'email', recipient, { heal: true });
    if (!holder) {
      return { ok: true, matched: false, workspaceId, customerId: null, state };
    }

    // Only escalate state, never downgrade — once undeliverable, stay
    // undeliverable (Postmark replay order isn't guaranteed).
    const rank = (s: string) => ({ none: 0, soft: 1, hard: 2, spam: 2 }[s] ?? 0);
    const bouncedAt = payload.BouncedAt || new Date().toISOString();

    // Per-address state on the contact row (PR 7 moves the suppression READ
    // here; writing it from day one means no second backfill later).
    const [row] = await sql<{ id: string; bounce_state: string; bounce_count: number }[]>`
      select id, bounce_state, bounce_count from customer_contacts
      where workspace_id = ${workspaceId} and customer_id = ${holder.id} and kind = 'email'
        and value = ${recipient} and deleted_at is null
    `;
    if (row) {
      const next = rank(state) >= rank(row.bounce_state || 'none') ? state : row.bounce_state;
      await sql`
        update customer_contacts set
          bounce_last_type = ${payload.Type},
          bounce_last_at   = ${bouncedAt},
          bounce_count     = ${(row.bounce_count || 0) + 1},
          bounce_state     = ${next}
        where id = ${row.id}
      `;
    }

    // The customer-level summary the SPA and the suppression list still read
    // is unchanged in meaning — it describes the PRIMARY address (the mirror),
    // so it only moves when the bounced address IS the primary.
    const [customer] = await sql<{ id: string; email_bounce_count: number; email_bounce_state: string | null }[]>`
      select id, email_bounce_count, email_bounce_state from customers
      where id = ${holder.id} and workspace_id = ${workspaceId} and email = ${recipient} and deleted_at is null
    `;
    if (customer) {
      const nextState = rank(state) >= rank(customer.email_bounce_state || 'none')
        ? state
        : customer.email_bounce_state;
      await sql`
        update customers set
          email_last_bounce_type = ${payload.Type},
          email_last_bounce_at   = ${bouncedAt},
          email_bounce_count     = ${(customer.email_bounce_count || 0) + 1},
          email_bounce_state     = ${nextState}
        where id = ${customer.id}
      `;
    }

    return { ok: true, matched: true, workspaceId, customerId: holder.id, state };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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
