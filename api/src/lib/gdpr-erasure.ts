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
import { deleteKeys } from './r2.js';
import { sendOpsAlert } from './alert.js';

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
  attachmentsDeleted: number;
}

// The R2 object deleter — injectable so tests can record the keys without R2
// config or a network call. Defaults to the real lib/r2 deleteKeys.
export interface EraseDeps {
  deleteObjects?: (keys: string[]) => Promise<void>;
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
}, deps: EraseDeps = {}): Promise<EraseResult | null> {
  const { workspaceId, customerId, requestedByUserId, reason } = args;
  const deleteObjects = deps.deleteObjects ?? deleteKeys;
  const db = getDb();

  // Captured inside the transaction, consumed after it commits: the R2 object
  // keys to delete. R2 is not transactional, so we do the (irreversible) object
  // delete only once the DB is durably consistent — not mid-transaction where a
  // later failure would roll the rows back to point at already-deleted files, or
  // hold a pooled connection + row lock across network I/O.
  let attachmentKeys: string[] = [];

  const result = await db.begin(async (sql) => {
    // Lock the customer row (scoped) so a concurrent erase can't double-run.
    const [cust] = await sql<{ id: string; email: string | null; erased_at: string | null }[]>`
      select id, email, erased_at from customers
      where id = ${customerId} and workspace_id = ${workspaceId}
      for update
    `;
    if (!cust) return null;
    if (cust.erased_at) {
      return { erased: true, alreadyErased: true, fieldsErased: [], ticketsAffected: 0, notesDeleted: 0, messagesRedacted: 0, inboxRedacted: 0, attachmentsDeleted: 0 };
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
    let attachmentsDeleted = 0;

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

      // Attachments: files live in R2 keyed by storage_key; the rows link only to
      // tickets (ON DELETE CASCADE) — but erasure KEEPS the tickets (anonymised),
      // so nothing removes them unless we do it here. Delete the rows in-txn
      // (atomic with the rest of the erase) and stash the keys; the R2 objects
      // are deleted after commit (see below).
      const atts = await sql<{ storage_key: string }[]>`
        select storage_key from ticket_attachments
        where workspace_id = ${workspaceId} and ticket_id in ${sql(ticketIds)}
      `;
      if (atts.length) {
        attachmentKeys = atts.map((a) => a.storage_key);
        await sql`
          delete from ticket_attachments
          where workspace_id = ${workspaceId} and ticket_id in ${sql(ticketIds)}
        `;
        attachmentsDeleted = attachmentKeys.length;
      }
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
      attachmentsDeleted,
    };
  });

  // Post-commit: delete the attachment objects from R2. Done outside the txn so
  // no DB connection/lock is held across network I/O, and only after the DB is
  // durably erased. Best-effort: the DB (system of record) is already consistent
  // and the rows are gone; if object deletion fails we alert for manual cleanup
  // rather than fail an otherwise-complete erasure or resurrect the DB rows.
  // (`result` is only reached on commit; a rolled-back txn throws above.)
  if (result && !result.alreadyErased && attachmentKeys.length) {
    try {
      await deleteObjects(attachmentKeys);
    } catch (err) {
      console.error(
        `[gdpr-erase] R2 object deletion failed for customer ${customerId} (workspace ${workspaceId}):`,
        err instanceof Error ? err.message : err,
      );
      // Never let an alerting failure mask the (successful) erasure.
      await sendOpsAlert({
        signature: `gdpr-erase-r2-fail:${workspaceId}:${customerId}`,
        severity: 'critical',
        title: 'GDPR erasure: attachment file deletion failed',
        detail:
          `Customer ${customerId} (workspace ${workspaceId}) was erased in the database, but ` +
          `${attachmentKeys.length} attachment object(s) could not be deleted from storage. ` +
          `Manual cleanup required.\nKeys:\n` + attachmentKeys.map((k) => `  • ${k}`).join('\n'),
      }).catch(() => {});
    }
  }

  return result;
}
