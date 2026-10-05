import { safeError } from './diagnostics.js';
// GDPR right-to-erasure for a customer (data subject).
//
// Nulls/redacts the customer's personal data across every PII surface and
// writes a `gdpr_erasures` audit row, in ONE transaction. The customer + ticket
// rows are kept (anonymised) so the audit trail and aggregate analytics survive
// — see `20260520121300_gdpr.sql` for that design intent, and
// `docs/gdpr-pii-inventory.md` for the canonical surface list this implements.
//
// Repeated erasure scrubs again (including historical omissions) without a
// duplicate audit row. Historical bulk repair requires explicit approval.

import { getDb } from './db.js';
import { HTTPException } from 'hono/http-exception';
import {
  deleteAttachmentObjects,
  drainObjectDeletions,
  enqueueObjectDeletions,
  sweepPendingObjectDeletions,
  type DeleteObjectsFn,
} from './object-outbox.js';
import { sendOpsAlert } from './alert.js';
import { inboxFromThisCustomer, repairCustomerContacts } from './customer-contacts.js';

// Marker for NOT NULL text columns we can't null (subject, message body).
const ERASED = '[erased]';

// The customers columns this nulls — recorded verbatim in gdpr_erasures.fields_erased.
//
// kyc_status remains a PII key for legacy merge journals and schema-compatible
// deployments. Erasure handles its customer column only while present; the
// retirement migration removes the column and repairs already-erased journals.
// Exported so other writers of customer data (routes/customers.ts PATCH audit)
// derive "which columns may have their VALUES logged" from this one list
// instead of keeping a second copy that can drift.
export const CUSTOMER_PII_FIELDS = [
  'first_name', 'last_name', 'username', 'email', 'mobile',
  'backoffice_url', 'kyc_status', 'jurisdiction',
  // Maestro player ids name the subject's casino account — direct identifiers.
  'maestro_user_id', 'maestro_member_id',
] as const;

// What gdpr_erasures.fields_erased records: the columns above plus 'contacts'
// — the customer_contacts rows (Phase 4 contacts model), which are a table,
// not a column, and are hard-deleted below.
const FIELDS_ERASED = [...CUSTOMER_PII_FIELDS, 'contacts', 'tickets.last_inbound_email', 'tickets.closure_note', 'note_revisions', 'ticket_messages.email_metadata', 'message_drafts', 'custom_field_values', 'webhook_deliveries', 'tickets.ai_summary', 'tickets.ai_draft_reply', 'ticket_tags', 'ticket_ai_tags', 'time_entries.note', 'merged_message_copies', 'reply_internal_reviews'] as const;

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
// config or a network call. Defaults to the PRIVATE attachments bucket
// (lib/object-outbox.ts) — never the public brand-assets bucket.
export interface EraseDeps {
  deleteObjects?: DeleteObjectsFn;
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
  const deleteObjects = deps.deleteObjects ?? deleteAttachmentObjects;
  const db = getDb();

  // Captured inside the transaction, consumed after it commits: the R2 object
  // keys to delete. R2 is not transactional, so we do the (irreversible) object
  // delete only once the DB is durably consistent — not mid-transaction where a
  // later failure would roll the rows back to point at already-deleted files, or
  // hold a pooled connection + row lock across network I/O. The same keys are
  // written to the pending_object_deletions outbox IN the transaction, so a
  // crash between commit and delete can't orphan a file.
  let attachmentKeys: string[] = [];

  const result = await db.begin(async (sql) => {
    // Same order as bounded sends: workspace, customer, then ticket. This also
    // invalidates workspace-wide assistant requests which have no ticket id.
    const [workspace] = await sql`select id from workspaces where id=${workspaceId} for update`;
    if (!workspace) return null;
    // Lock the customer row (scoped) so a concurrent erase can't double-run.
    const [cust] = await sql<{ id: string; email: string | null; erased_at: string | null; has_legacy_kyc: boolean }[]>`
      select id, email, erased_at, to_jsonb(customers) ? 'kyc_status' as has_legacy_kyc from customers
      where id = ${customerId} and workspace_id = ${workspaceId}
      for update
    `;
    if (!cust) return null;
    // Live merged sources are unmerged by the route first. Soft-deleted
    // sources cannot take that path. Do not certify a partial erase or guess
    // which newer survivor correspondence belongs to the original subject.
    const [unresolvedMerge] = await sql`select 1 where exists (
      select 1 from tickets where workspace_id=${workspaceId} and pre_merge_customer_id=${customerId}
        and customer_id<>${customerId}
    ) or exists (
      select 1 from customers where workspace_id=${workspaceId} and merged_into_customer_id=${customerId}
    ) or exists (
      select 1 from customer_merges j join customers source on source.id=j.source_customer_id and source.workspace_id=j.workspace_id
      where j.workspace_id=${workspaceId} and j.source_customer_id=${customerId} and j.unmerged_at is null
        and source.merged_into_customer_id is not null and j.backfilled_fields ?| ${[...CUSTOMER_PII_FIELDS]}::text[]
    )`;
    if (unresolvedMerge) throw new HTTPException(409, { message: 'This profile still has merged ticket history or copied personal fields. Resolve the merge before erasing it.' });
    await sql`update workspaces set privacy_generation=privacy_generation+1 where id=${workspaceId}`;
    // The scalar is captured BEFORE nulling — the inbox match below also uses
    // it for a legacy profile with no contact rows.
    const email = cust.email;
    // This transaction's customer lock also prevents concurrent DROP COLUMN.
    // Keep erasing legacy data until the column is physically retired, while
    // allowing this release to run after that migration (including rollback).
    const fieldsErased = FIELDS_ERASED.filter(field => cust.has_legacy_kyc || field !== 'kyc_status');

    const ticketRows = await sql<{ id: string }[]>`
      select id from tickets where workspace_id = ${workspaceId} and customer_id = ${customerId}
    `;
    const ticketIds = ticketRows.map((r) => r.id);
    // A ticket merge can copy content onto another customer's ticket. Clear
    // derived output there, but preserve its own correspondence and identity.
    const copiedTargets = ticketIds.length ? await sql<{ id: string }[]>`
      select distinct ticket_id as id from ticket_messages where workspace_id=${workspaceId}
        and merged_from_id in ${sql(ticketIds)}` : [];
    const affectedIds = [...new Set([...ticketIds,...copiedTargets.map(t => t.id)])];
    if (affectedIds.length) {
      await sql`update tickets set ai_summary=null,ai_draft_reply=null,privacy_generation=privacy_generation+1
        where workspace_id=${workspaceId} and id in ${sql(affectedIds)}`;
      await sql`delete from ticket_ai_tags where workspace_id=${workspaceId} and ticket_id in ${sql(affectedIds)}`;
      await sql`delete from ai_reply_suggestions where workspace_id=${workspaceId} and ticket_id in ${sql(affectedIds)}`;
    }

    // A CC or third-party sender can also appear on somebody else's ticket.
    // Clear that envelope without granting the contact ownership of the ticket.
    await sql`update ticket_messages m set email_metadata=null where m.workspace_id=${workspaceId}
      and m.email_metadata is not null and exists (
        select 1 from jsonb_path_query(m.email_metadata, '$.** ? (@.type() == "string")') value
        where lower(value #>> '{}') in (
          select lower(value::text) from customer_contacts where workspace_id=${workspaceId}
            and customer_id=${customerId} and kind='email'
          union select lower(${email}::text)
        )
      )`;

    let messagesRedacted = 0;
    let ticketsAffected = 0;
    let inboxRedacted = 0;
    let attachmentsDeleted = 0;

    if (ticketIds.length) {
      await sql`delete from note_revisions r using ticket_messages m
        where r.ticket_message_id = m.id and r.workspace_id = ${workspaceId}
          and m.workspace_id = ${workspaceId}
          and (m.ticket_id in ${sql(ticketIds)} or m.merged_from_id in ${sql(ticketIds)})`;

      await sql`delete from reply_internal_reviews r using ticket_messages m
        where r.message_id=m.id and r.workspace_id=${workspaceId}
          and m.workspace_id=${workspaceId} and m.ticket_id in ${sql(ticketIds)}`;
      // Copied messages and their cascading reviews/revisions belong to the
      // source subject; removing them leaves the destination owner's messages.
      await sql`delete from ticket_messages where workspace_id=${workspaceId}
        and merged_from_id in ${sql(ticketIds)} and ticket_id not in ${sql(ticketIds)}`;
      await sql`delete from ticket_tags where workspace_id=${workspaceId} and ticket_id in ${sql(ticketIds)}`;
      await sql`update time_entries set note=null where workspace_id=${workspaceId} and ticket_id in ${sql(ticketIds)}`;
      const msgs = await sql`
        update ticket_messages set
          body = ${ERASED},
          -- The formatted body holds the same personal data as the text body
          -- (plus the customer's own markup): it must go with it.
          body_html = null,
          email_metadata = null,
          author_label = case when role = 'customer' then ${ERASED} else author_label end
        where workspace_id = ${workspaceId} and ticket_id in ${sql(ticketIds)}
      `;
      messagesRedacted = msgs.count;

      const tks = await sql`
        update tickets set subject = ${ERASED}, csat_comment = null, snooze_reason = null, last_inbound_email = null, closure_note = null
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
      attachmentKeys = [...new Set(atts.map((a) => a.storage_key))];
      attachmentsDeleted = atts.length;
      await enqueueObjectDeletions(sql, attachmentKeys, 'erasure');
    }

    // Un-converted inbound mail still in the inbox, matched by sender address —
    // EVERY address the subject held, each within its own lifetime, so mail a
    // later holder of a released address sent is not this subject's
    // (inboxFromThisCustomer). Runs BEFORE the contact rows are deleted below.
    const inbMail = await sql`
      update inbox_messages set
        from_name = null, from_email = null, subject = null, body = null, body_html = null, raw = null
      where workspace_id = ${workspaceId} and ${inboxFromThisCustomer(sql, workspaceId, customerId, email)}
    `;
    inboxRedacted += inbMail.count;

    await sql`delete from note_revisions r using customer_notes n
      where r.customer_note_id = n.id and r.workspace_id = ${workspaceId} and n.workspace_id = ${workspaceId}
        and (n.customer_id = ${customerId} or n.merged_from_customer_id = ${customerId})`;
    const notes = await sql`
      delete from customer_notes where workspace_id = ${workspaceId}
        and (customer_id = ${customerId} or merged_from_customer_id = ${customerId})
    `;
    const notesDeleted = notes.count;

    // Contact rows are HARD-deleted: a soft-deleted row would keep the address
    // as personal data forever (same treatment notes get). The erase route
    // un-merges a merged-away source first, so its rows are back on it here.
    // …including rows a merge re-homed onto a survivor (stamped with this
    // subject's id). The erase route un-merges a LIVE merged-away source first,
    // but a source soft-deleted after its merge can't be un-merged, and its
    // addresses are still the subject's data. Survivors that held them get
    // their primaries and mirror repaired.
    const goneRows = await sql<{ customer_id: string }[]>`
      delete from customer_contacts
      where workspace_id = ${workspaceId}
        and (customer_id = ${customerId} or merged_from_customer_id = ${customerId})
      returning customer_id
    `;
    for (const holderId of new Set(goneRows.map((r) => r.customer_id).filter((id) => id !== customerId))) {
      await repairCustomerContacts(sql, workspaceId, holderId);
    }

    await sql`
      update customers set
        first_name = null, last_name = null, username = null, email = null,
        mobile = null, backoffice_url = null,
        ${cust.has_legacy_kyc ? sql`kyc_status = null,` : sql``}
        jurisdiction = null,
        maestro_user_id = null, maestro_member_id = null, maestro_global_id_verified = false, player_lookup_at = null,
        erased_at = coalesce(erased_at, now())
      where id = ${customerId} and workspace_id = ${workspaceId}
    `;
    // The erased_at trigger also deletes drafts, custom values and webhook payloads.
    // Database guards serialize their writes with this customer lock.

    // Every historical merge can retain copied source PII after unmerge.
    // Keep non-personal backfills and the journal itself as merge history.
    await sql`
      update customer_merges set backfilled_fields = backfilled_fields - ${[...CUSTOMER_PII_FIELDS]}::text[]
      where workspace_id = ${workspaceId} and source_customer_id = ${customerId}
        and backfilled_fields ?| ${[...CUSTOMER_PII_FIELDS]}::text[]
    `;

    if (!cust.erased_at) await sql`
      insert into gdpr_erasures (workspace_id, customer_id, requested_by_user_id, completed_at, fields_erased, reason)
      values (${workspaceId}, ${customerId}, ${requestedByUserId}, now(), ${fieldsErased}, ${reason ?? null})
    `;

    return {
      erased: true,
      alreadyErased: Boolean(cust.erased_at),
      fieldsErased,
      ticketsAffected,
      notesDeleted,
      messagesRedacted,
      inboxRedacted,
      attachmentsDeleted,
    };
  });

  // Post-commit: delete the attachment objects from R2. Done outside the txn so
  // no DB connection/lock is held across network I/O, and only after the DB is
  // durably erased. Each key that succeeds is cleared from the outbox; any that
  // fail stay there for the retry sweep (retryPendingObjectDeletions, run from
  // the retention cron) — the attachment rows are already gone, so the outbox
  // is the only durable record of what's left to delete. We also alert.
  // (`result` is only reached on commit.)
  if (result && attachmentKeys.length) {
    const { failed } = await drainObjectDeletions(attachmentKeys, deleteObjects);
    if (failed.length) {
      console.error('[gdpr-erase] object deletion deferred', { failed: failed.length });
      await sendOpsAlert({
        signature: `gdpr-erase-r2-fail:${workspaceId}`,
        severity: 'critical',
        title: 'GDPR erasure: attachment file deletion failed',
        detail:
          `Database erasure completed in workspace ${workspaceId}, but ` +
          `${failed.length} attachment object(s) could not be deleted from storage. ` +
          `Left in pending_object_deletions for automatic retry on the next retention cron.`,
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
): Promise<{
  swept: number; cleared: number; keysDeleted: number; parkedKeysDeleted: number;
  // Outbox keys that keep failing — the caller alerts on these.
  stuck: Array<{ storage_key: string; attempts: number; last_error: string | null }>;
}> {
  const deleteObjects = deps.deleteObjects ?? deleteAttachmentObjects;
  const sql = getDb();
  // The outbox (pending_object_deletions) — written by erasure AND the
  // retention purge. Per-key isolation inside the sweep: one stuck object
  // accrues attempts, everything else drains.
  let parkedKeysDeleted = 0;
  let stuck: Awaited<ReturnType<typeof sweepPendingObjectDeletions>>['stuck'] = [];
  try {
    const swept = await sweepPendingObjectDeletions(Math.max(1, limit), deleteObjects);
    parkedKeysDeleted = swept.deleted.length;
    stuck = swept.stuck;
    if (swept.failed.length) {
      console.warn(`[object-outbox] ${swept.failed.length} parked object deletion(s) still failing`);
    }
  } catch (err) {
    console.warn('[object-outbox] sweep failed:', safeError(err));
  }
  // Legacy: keys parked on gdpr_erasures.pending_object_keys by erasures that
  // ran before the outbox existed. Drained here until the column is empty.
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
      console.warn('[gdpr-erase] retry still failing:', safeError(err));
    }
  }
  return { swept: rows.length, cleared, keysDeleted, parkedKeysDeleted, stuck };
}
