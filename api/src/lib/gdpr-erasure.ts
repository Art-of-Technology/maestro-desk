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
  // The gdpr_erasures row id, captured in-txn so a post-commit R2 failure can
  // durably park the un-deleted keys on it for the retry sweep.
  let erasureId: string | null = null;

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
        delete from ticket_attachments
        where workspace_id = ${workspaceId} and ticket_id in ${sql(ticketIds)}
        returning storage_key
      `;
      attachmentKeys = atts.map((a) => a.storage_key);
      attachmentsDeleted = attachmentKeys.length;
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

    const [era] = await sql<{ id: string }[]>`
      insert into gdpr_erasures (workspace_id, customer_id, requested_by_user_id, completed_at, fields_erased, reason)
      values (${workspaceId}, ${customerId}, ${requestedByUserId}, now(), ${[...CUSTOMER_PII_FIELDS]}, ${reason ?? null})
      returning id
    `;
    erasureId = era.id;

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
  // durably erased. If object deletion fails, the keys are PARKED on the
  // gdpr_erasures row (pending_object_keys) so the retry sweep
  // (retryPendingObjectDeletions, run from the retention cron) finishes the job
  // — the DB rows are already gone, so this is the only durable record of what's
  // left to delete. We also alert. (`result` is only reached on commit.)
  if (result && !result.alreadyErased && attachmentKeys.length) {
    try {
      await deleteObjects(attachmentKeys);
    } catch (err) {
      console.error(
        `[gdpr-erase] R2 object deletion failed for customer ${customerId} (workspace ${workspaceId}) — parking for retry:`,
        err instanceof Error ? err.message : err,
      );
      // Persist the un-deleted keys for the retry sweep. If even this fails, the
      // alert below is the backstop; never let it mask the successful erasure.
      try {
        if (erasureId) {
          await db`update gdpr_erasures set pending_object_keys = ${attachmentKeys} where id = ${erasureId}`;
        }
      } catch (persistErr) {
        console.error('[gdpr-erase] failed to park pending object keys:', persistErr instanceof Error ? persistErr.message : persistErr);
      }
      await sendOpsAlert({
        signature: `gdpr-erase-r2-fail:${workspaceId}:${customerId}`,
        severity: 'critical',
        title: 'GDPR erasure: attachment file deletion failed',
        detail:
          `Customer ${customerId} (workspace ${workspaceId}) was erased in the database, but ` +
          `${attachmentKeys.length} attachment object(s) could not be deleted from storage. ` +
          `Parked for automatic retry; will also self-heal on the next retention cron.\nKeys:\n` +
          attachmentKeys.map((k) => `  • ${k}`).join('\n'),
      }).catch(() => {});
    }
  }

  return result;
}

/**
 * Retry sweep for attachment objects that failed to delete during erasure. Reads
 * gdpr_erasures rows still carrying pending_object_keys, re-attempts the R2
 * delete, and clears the keys on success. Idempotent and safe to run repeatedly
 * (re-deleting an already-gone key is a 404 = success). Best-effort per row: one
 * row's failure doesn't block the others. Runs from the retention cron.
 */
export async function retryPendingObjectDeletions(
  limit = 100,
  deps: EraseDeps = {},
): Promise<{ swept: number; cleared: number; keysDeleted: number }> {
  const deleteObjects = deps.deleteObjects ?? deleteKeys;
  const sql = getDb();
  const rows = await sql<{ id: string; pending_object_keys: string[] }[]>`
    select id, pending_object_keys from gdpr_erasures
    where pending_object_keys is not null and cardinality(pending_object_keys) > 0
    order by completed_at asc
    limit ${Math.max(1, limit)}
  `;
  let cleared = 0;
  let keysDeleted = 0;
  for (const row of rows) {
    try {
      await deleteObjects(row.pending_object_keys);
      await sql`update gdpr_erasures set pending_object_keys = null where id = ${row.id}`;
      cleared++;
      keysDeleted += row.pending_object_keys.length;
    } catch (err) {
      console.warn(`[gdpr-erase] retry still failing for erasure ${row.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return { swept: rows.length, cleared, keysDeleted };
}
