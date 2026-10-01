# GDPR PII Inventory — Respovia

> Wave 2 of the compliance build-out (`IMPLEMENTATION-PLAN.md` Phase 4). This is the
> **shared spec** for erasure, data-subject export, and retention — enumerate every
> column that holds personal data of a *player/customer* (the data subject) once, so
> each of those features covers the same surfaces and none is missed.
> Last reviewed 2026-10-01 for drafts, custom values and webhook erasure. This is an implementation inventory, not a declaration of GDPR compliance. Update when a new personal-data surface lands.

A "data subject" here is a **customer** (player). Agent/operator accounts are users and
out of scope for customer erasure. The design intent (`20260520121300_gdpr.sql`): keep the
customer row + ticket rows so the audit trail and aggregate analytics survive, but **null /
redact the personal data** and stamp `customers.erased_at`.

## Surfaces

| Table | PII column(s) | Handling on erasure | Notes |
|---|---|---|---|
| `customers` | `first_name`, `last_name`, `username`, `email`, `mobile`, `backoffice_url`, `jurisdiction`, `maestro_user_id`, `maestro_member_id` | **null**; set `erased_at = now()` (also nulls `player_lookup_at`, the linker's throttle stamp, so nothing re-links an erased profile) | Row kept (FKs from tickets). `display_id`, `brand`, `vip_tier`, `since`, `consent` retained as non-identifying / preference. `maestro_user_id` / `maestro_member_id` (20260903100000) are the player's Maestro account identifiers, written by `lib/player-identity.ts` — direct identifiers, so erased and exported like `username`. `kyc_status` was retired by migration `20260908124500`; runtime compatibility still erases it on older schemas. |
| `customer_contacts` | `value` (every email / mobile the customer holds, incl. secondaries) | **delete rows** for the customer | Phase 4 contacts model. Hard-deleted (not soft) so no address survives as PII; `customers.email`/`mobile` are a mirror of the primary row and are nulled above. A merged-away source is un-merged first (erase route), so its rows are back on it when this runs. Profile soft-delete (`DELETE /customers/:id`) soft-deletes these rows instead, freeing the address for reuse. |
| `customer_merges` | Personal-data keys in `backfilled_fields` | **remove keys** from every journal whose source is the erased customer, scoped to its workspace | Unmerge restores copied values before erasure. Other backfills and journal rows remain as history. The KYC retirement migration also repairs journals for previously erased sources. |
| `customer_notes` | `text` (NOT NULL) | **delete rows** for the customer | Internal agent notes *about* the data subject — removed entirely. |
| `note_revisions` | `before_text`, `after_text`, `before_html` | **delete revision rows** for the subject’s contact notes and ticket messages, including merge provenance | Exports include revisions. Note deletion/retention cascades remove their revisions. Permanent audit entries retain revision identifiers without note content. |
| `tickets` | `subject` (NOT NULL), `csat_comment`, `snooze_reason`, `last_inbound_email` | `subject → '[erased]'`; other listed fields → null | Row kept; status/category/timestamps retained for analytics. The last inbound sender is included in the data-subject export and cleared on erasure. |
| `ticket_messages` | `body` (NOT NULL), `body_html`, `author_label`, `email_metadata` | `body → '[erased]'`; `body_html` and `email_metadata → null`; `author_label → '[erased]'` only where `role = 'customer'` | Row kept (thread structure / audit). Email envelopes are included in ticket exports. Erasure also clears envelopes on other tickets containing the subject's email addresses, including CC and copied merge messages. Envelope addresses never establish customer identity. Agent/AI author labels are staff, not the data subject. |
| `inbox_messages` | `from_name`, `from_email`, `subject`, `body`, `body_html`, `raw` | **null** all | Matched by `converted_ticket_id ∈ customer's tickets` OR `from_email = customer.email`. |
| `message_drafts` | `body`, `recipients`, `review`, attachment references | **delete all agents' drafts** on the subject's tickets | Database guards reject stale content writes after erasure; browser copies and export coverage remain follow-ups. |
| `custom_field_values` | `value` | **delete** customer values and values on their tickets | Scoped by workspace and entity type/id. Database guards prevent stale writes; export coverage remains a follow-up. |
| `webhook_deliveries` | Customer details and ticket subject in `payload` | **delete** matching customer or ticket snapshots, including pending retries | Scoped by workspace and payload identifiers. A delivery already in flight finishes before erasure can complete. Copies already delivered to recipients require a separate downstream process. |
| `gdpr_erasures` | — | **insert** the erasure record | `requested_by_user_id`, `completed_at`, `fields_erased[]`, `reason`. |

## Intentionally retained (by design)

- **`tickets` / `ticket_messages` rows** — kept (redacted) so the support history and the
  audit trail referencing the now-anonymous customer survive.
- **`events` / `audit_events`** — the activity/audit log; it references the anonymized
  customer, not their content. Player-data **reads** are now logged here too (a
  `player.viewed` audit event on every successful live player lookup — `routes/maestro.ts`
  + `lib/player-audit.ts`, categories not values), as is every automatic or agent-driven
  contact ↔ player link or repair of missing account details (`customer.player_linked`
  / `customer.player_refreshed` — `lib/player-identity.ts`; the brand id
  and data categories persisted, never the values or the player ids themselves). Profile
  edits from the details card (`customer.updated` — `PATCH /customers/:id`) follow the same
  rule: before/after values only for the non-identifying columns (`brand`, `vip_tier`, `since`,
  `consent`); the PII columns that changed are listed by field name alone.
  Audit chains are tamper-evident and checked by the retention job. Retained
  identifiers/attributes can still be personal data when linkable; their retention
  needs a documented purpose, rather than an assumption of anonymity.

## Attachments — `ticket_attachments` + the R2 objects

Inbound and uploaded attachments are live product features and can contain personal data.

- **Erasure** — `gdpr-erasure.ts` deletes the `ticket_attachments` rows for the customer's
  tickets (in-transaction), writes their `storage_key`s to the `pending_object_deletions`
  OUTBOX in that same transaction, and deletes the R2 objects after commit — clearing each
  key as it succeeds. A crash or R2 outage therefore always leaves a durable pointer, and
  `retryPendingObjectDeletions()` (run from the retention cron) finishes the job, so the
  outage self-heals. Erasures written before the outbox existed still carry their keys on
  `gdpr_erasures.pending_object_keys`; the same sweep drains that column too.
  ✅ implemented.
- **Retention** — the purge (`lib/retention.ts`) does exactly the same: `storage_key`s of
  every expiring ticket go to the outbox inside the delete transaction, objects are deleted
  after commit, and the cron retries whatever is left. ✅ implemented.
- **Stuck keys are visible** — each outbox row counts `attempts` and records `last_error`;
  the retention cron raises a critical ops alert when a key keeps failing, so a file that
  can never be deleted (bad token, wrong bucket) is not silently retained forever.
- **Storage** — attachments live in a separate PRIVATE bucket (`R2_ATTACHMENTS_BUCKET`)
  and are served only via short-lived presigned URLs minted inside authenticated ticket
  responses. Never the public brand-assets bucket.
- **DSAR export** — `gdpr-export.ts` includes attachment metadata, but not document
  contents. Complete the access-request workflow with review/redaction and secure
  delivery of relevant documents.

## Erasure repair and remaining product-wide work

Migration `20261001140000_erasure_auxiliary_data.sql` repairs drafts, custom values and
webhook snapshots for customers already marked erased. The same cleanup runs atomically
when `erased_at` is set. It leaves other customers and workspaces unchanged. These
guards cover these three surfaces; they are not a product-wide ban on every possible
write to an erased ticket.

Still to assess/remediate: export completeness; browser draft retention/logout; legacy
AI content and other copied records; logs and notification payloads; staff-data rights;
retention by data category; backup restore erasure replay; downstream recipient deletion;
processor contracts, locations/transfers, AI handling, privacy notices and DPIA needs.
Customer erasure is not a substitute for a staff-data rights process.

## Consumers of this inventory

- `feat/gdpr-erasure` — implemented in `api/src/lib/gdpr-erasure.ts` (this table is the contract).
- `feat/data-export` — DSAR export must surface every column above for the data subject.
- `feat/data-retention` — the purge job operates on the same tables (full delete past the
  retention window, vs. redaction here).
