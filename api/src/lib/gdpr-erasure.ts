// GDPR right-to-erasure for a customer (data subject).
//
// Nulls/redacts the customer's personal data across every PII surface and
// writes a `gdpr_erasures` audit row, in ONE transaction. The customer + ticket
// rows are kept (anonymised) so the audit trail and aggregate analytics survive
// — see `20260520121300_gdpr.sql` for that design intent, and
// `docs/gdpr-pii-inventory.md` for the canonical surface list this implements.
//
// Idempotent: a customer already carrying `erased_at` short-circuits without a
// second pass or a duplicate audit row.

import { getDb } from './db.js';

// Marker for NOT NULL text columns we can't null (subject, message body).
const ERASED = '[erased]';

// The customers columns this nulls — recorded verbatim in gdpr_erasures.fields_erased.
const CUSTOMER_PII_FIELDS = [
  'first_name', 'last_name', 'username', 'email', 'mobile',
  'backoffice_url', 'kyc_status', 'jurisdiction',
] as const;

export interface EraseResult {
  erased: boolean;
  alreadyErased: boolean;
  fieldsErased: string[];
  ticketsAffected: number;
  notesDeleted: number;
  messagesRedacted: number;
  inboxRedacted: number;
}

/**
 * Erase a customer's personal data. Returns null if no such customer exists in
 * the workspace (caller maps to 404). Scoped by workspace_id throughout — there
 * is no DB-level tenant guard, so every statement carries the predicate.
 */
export async function eraseCustomer(args: {
  workspaceId: string;
  customerId: string;
  requestedByUserId: string | null;
  reason?: string | null;
}): Promise<EraseResult | null> {
  const { workspaceId, customerId, requestedByUserId, reason } = args;
  const db = getDb();

  return db.begin(async (sql) => {
    // Lock the customer row (scoped) so a concurrent erase can't double-run.
    const [cust] = await sql<{ id: string; email: string | null; erased_at: string | null }[]>`
      select id, email, erased_at from customers
      where id = ${customerId} and workspace_id = ${workspaceId}
      for update
    `;
    if (!cust) return null;
    if (cust.erased_at) {
      return { erased: true, alreadyErased: true, fieldsErased: [], ticketsAffected: 0, notesDeleted: 0, messagesRedacted: 0, inboxRedacted: 0 };
    }
    // Capture the email BEFORE nulling — needed to match un-converted inbox mail.
    const email = cust.email;

    const ticketRows = await sql<{ id: string }[]>`
      select id from tickets where workspace_id = ${workspaceId} and customer_id = ${customerId}
    `;
    const ticketIds = ticketRows.map((r) => r.id);

    let messagesRedacted = 0;
    let ticketsAffected = 0;
    let inboxRedacted = 0;

    if (ticketIds.length) {
      const msgs = await sql`
        update ticket_messages set
          body = ${ERASED},
          author_label = case when role = 'customer' then ${ERASED} else author_label end
        where workspace_id = ${workspaceId} and ticket_id in ${sql(ticketIds)}
      `;
      messagesRedacted = msgs.count;

      const tks = await sql`
        update tickets set subject = ${ERASED}, csat_comment = null, snooze_reason = null
        where workspace_id = ${workspaceId} and id in ${sql(ticketIds)}
      `;
      ticketsAffected = tks.count;

      const inbConv = await sql`
        update inbox_messages set
          from_name = null, from_email = null, subject = null, body = null, body_html = null, raw = null
        where workspace_id = ${workspaceId} and converted_ticket_id in ${sql(ticketIds)}
      `;
      inboxRedacted += inbConv.count;
    }

    // Un-converted inbound mail still in the inbox, matched by sender address.
    if (email) {
      const inbMail = await sql`
        update inbox_messages set
          from_name = null, from_email = null, subject = null, body = null, body_html = null, raw = null
        where workspace_id = ${workspaceId} and from_email = ${email}
      `;
      inboxRedacted += inbMail.count;
    }

    const notes = await sql`
      delete from customer_notes where workspace_id = ${workspaceId} and customer_id = ${customerId}
    `;
    const notesDeleted = notes.count;

    await sql`
      update customers set
        first_name = null, last_name = null, username = null, email = null,
        mobile = null, backoffice_url = null, kyc_status = null, jurisdiction = null,
        erased_at = now()
      where id = ${customerId} and workspace_id = ${workspaceId}
    `;

    await sql`
      insert into gdpr_erasures (workspace_id, customer_id, requested_by_user_id, completed_at, fields_erased, reason)
      values (${workspaceId}, ${customerId}, ${requestedByUserId}, now(), ${[...CUSTOMER_PII_FIELDS]}, ${reason ?? null})
    `;

    return {
      erased: true,
      alreadyErased: false,
      fieldsErased: [...CUSTOMER_PII_FIELDS],
      ticketsAffected,
      notesDeleted,
      messagesRedacted,
      inboxRedacted,
    };
  });
}
