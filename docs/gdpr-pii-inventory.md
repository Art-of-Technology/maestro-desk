# GDPR PII Inventory — Respovia

> Wave 2 of the compliance build-out (`IMPLEMENTATION-PLAN.md` Phase 4). This is the
> **shared spec** for erasure, data-subject export, and retention — enumerate every
> column that holds personal data of a *player/customer* (the data subject) once, so
> each of those features covers the same surfaces and none is missed.
> Last reviewed 2026-10-05 for S2 saved content and S3 activity/audit controls. Historical audit repair remains outstanding. This is an implementation inventory, not a declaration of GDPR compliance.

A "data subject" here is a **customer** (player). Agent/operator accounts are users and
out of scope for customer erasure. The design intent (`20260520121300_gdpr.sql`): keep the
customer row + ticket rows so the audit trail and aggregate analytics survive, but **null /
redact the personal data** and stamp `customers.erased_at`.

## Surfaces

### S3 activity and audit boundaries

`events.details` and `author_label` are redacted on customer erasure; event identity
and kind survive for accountability and automatic-reply duplicate prevention.
Deleting a ticket/customer removes its activity rows. Database guards reject late
writes to erased or unavailable subjects. Older orphan events require review.

New `audit_events.metadata` is filtered to typed, approved facts before hashing;
names, addresses, subjects, previews and arbitrary context are dropped. Existing
audit content and hashes remain unchanged. New customer attribution survives
ticket/note retention. Historical missing links are not inferred from free text.

Exports include attributable activity, audit and erasure history for administrator
review, including after a profile has been erased. They explicitly warn about
retained historical content and unlinked records. New `gdpr_erasures.reason` values
are controlled codes; older narrative reasons remain reviewable in the export.
See [the S3 runbook](AUDIT-CONTENT-RELEASE.md) for observed production counts,
privilege findings, repair prerequisites and remaining release requirements.

### S2 additions and evidence boundaries

| Surface | Writers / readers | Erasure and export |
|---|---|---|
| `tickets.ai_summary`, `ai_draft_reply` | `lib/triage.ts`; ticket detail API and agent UI | Null on erasure, including destinations containing attributable merged copies. Both included in the review export. Ticket privacy versions reject late triage completion. |
| `ai_reply_suggestions`, shared draft/review fields, feedback and source links | `lib/reply-feedback.ts`, ticket/feedback routes | Existing deletion triggers remove target/source copies and cascading feedback. Export includes own and source-related suggestions for review. Persistence checks the request's privacy version. |
| `reply_internal_reviews.review` | Reply posting and ticket merge; ticket detail | Delete for owned messages and cascading removal of attributed copies. Included in review exports. |
| `ticket_messages.merged_from_id` copies | Ticket merge/unmerge; ticket detail | Remove attributable copies on other customers' tickets. Keep unrelated destination messages. Export groups attributed copies under the originating ticket. |
| Soft-deleted messages | Message/note routes | Still stored, so included with their deletion timestamp in the review export; erasure redacts them too. |
| `time_entries.note` | Ticket time-entry route; ticket detail/reports | Null the note, retain minutes/billable/timestamps as records subject to retention review. Include entries in the review export. |
| `ticket_tags`, `ticket_ai_tags` | Manual tagging, triage and acceptance; ticket detail/customer summary | Delete owned associations and affected AI suggestions. Include them in the review export. Shared `tag_library` text is not blindly deleted across other customers; attribution/retention remains open. |
| Delayed AI responses and outbound mail | Triage, AI messages, agent/auto replies, CSAT and mention email | Recheck privacy before persistence, response and bounded sends. Workspace version covers assistant requests with no ticket ID. An already accepted external send cannot be recalled. |

Database guards also cover personal content in tickets, messages, attachments,
customer notes, time entries and saved AI suggestions/reviews. They complement
the existing guards on manual drafts, custom fields and webhook payloads. Object
uploads rejected at insertion retain the existing orphan-deletion outbox path.
Customer erasure locks workspace then customer; a conflicting content writer
fails promptly instead of waiting in the opposite lock order.

The original inventory below describes existing handling, not a universal erasure
guarantee. In particular, retained customer attributes and identifiers are not
automatically anonymous, and events/audit metadata can contain personal free text
(confirmed separately as S3). Staff rights, unlinked mail, shared knowledge,
notification payloads, logs, supplier copies, backups and downloaded exports have
not been certified complete by this change. See [the release and repair runbook](ERASURE-RELEASE.md).

| Table | PII column(s) | Handling on erasure | Notes |
|---|---|---|---|
| `customers` | `first_name`, `last_name`, `username`, `email`, `mobile`, `backoffice_url`, `jurisdiction`, `maestro_user_id`, `maestro_member_id` | **null**; set `erased_at = now()` (also nulls `player_lookup_at`, the linker's throttle stamp, so nothing re-links an erased profile) | Row kept (FKs from tickets). `display_id`, `brand`, `vip_tier`, `since`, `consent` retained under the existing model; these can remain personal when linkable and need an approved retention purpose. `maestro_user_id` / `maestro_member_id` (20260903100000) are the player's Maestro account identifiers, written by `lib/player-identity.ts` — direct identifiers, so erased and exported like `username`. `kyc_status` was retired by migration `20260908124500`; runtime compatibility still erases it on older schemas. |
| `customer_contacts` | `value` (every email / mobile the customer holds, incl. secondaries) | **delete rows** for the customer | Phase 4 contacts model. Hard-deleted (not soft) so no address survives as PII; `customers.email`/`mobile` are a mirror of the primary row and are nulled above. A merged-away source is un-merged first (erase route), so its rows are back on it when this runs. Profile soft-delete (`DELETE /customers/:id`) soft-deletes these rows instead, freeing the address for reuse. |
| `customer_merges` | Personal-data keys in `backfilled_fields` | **remove keys** from every journal whose source is the erased customer, scoped to its workspace | Unmerge restores copied values before erasure. Other backfills and journal rows remain as history. The KYC retirement migration also repairs journals for previously erased sources. |
| `customer_notes` | `text` (NOT NULL) | **delete rows** for the customer | Internal agent notes *about* the data subject — removed entirely. |
| `note_revisions` | `before_text`, `after_text`, `before_html` | **delete revision rows** for the subject’s contact notes and ticket messages, including merge provenance | Exports include revisions. Note deletion/retention cascades remove their revisions. Permanent audit entries retain revision identifiers without note content. |
| `tickets` | `subject` (NOT NULL), `csat_comment`, `snooze_reason`, `last_inbound_email` | `subject → '[erased]'`; other listed fields → null | Row kept; status/category/timestamps retained for analytics. The last inbound sender is included in the data-subject export and cleared on erasure. |
| `ticket_messages` | `body` (NOT NULL), `body_html`, `author_label`, `email_metadata`, `sent_email`, `forwarded_from_ticket_ids` | `body → '[erased]'`; `body_html`, `email_metadata` and `sent_email → null`; `author_label → '[erased]'` only where `role = 'customer'` | Row kept (thread structure / audit). Email envelopes and saved composed email content are included in ticket exports. Forward origins are non-content links: forwards and copied attachment objects on other tickets are removed when an originating customer is erased. Erasure also clears envelopes on other tickets containing the subject's email addresses, including CC and copied merge messages. Envelope addresses never establish customer identity. Agent/AI author labels are staff, not the data subject. |
| `inbox_messages` | `from_name`, `from_email`, `subject`, `body`, `body_html`, `raw` | **null** all | Matched by `converted_ticket_id ∈ customer's tickets` OR `from_email = customer.email`. |
| `message_drafts` | `body`, `recipients`, `review`, attachment references | **delete all agents' drafts** on the subject's tickets | Database guards reject stale content writes after erasure; browser cleanup is described below. Included in the administrator review export. |
| `custom_field_values` | `value` | **delete** customer values and values on their tickets | Scoped by workspace and entity type/id. Database guards prevent stale writes. Included in the administrator review export. |
| `webhook_deliveries` | Customer details and ticket subject in `payload` | **delete** matching customer or ticket snapshots, including pending retries | Scoped by workspace and payload identifiers. A delivery already in flight finishes before erasure can complete. Copies already delivered to recipients require a separate downstream process. |
| `gdpr_erasures` | — | **insert** the erasure record | `requested_by_user_id`, `completed_at`, `fields_erased[]`, `reason`. |

## Intentionally retained (by design)

- **`tickets` / `ticket_messages` rows** — kept (redacted) so the support history and the
  audit trail referencing the now-anonymous customer survive.
- **`events` / `audit_events`** — see S3 above. Activity narrative is erasable;
  immutable audit facts, identifiers and historical personal text remain subject
  to retention and rights review. Audit chains are tamper-evident, not protection
  against a database superuser. Player reads retain identifiers and accessed
  categories; new profile-edit audit records retain field names without values.

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

## Administrator privacy actions

The ticket privacy dialog and sidebar use the same admin-only customer export and erasure
APIs. Erasure requires typing the customer display ID; merged-profile conflicts and API
errors are shown without claiming success. Successful erasure clears known browser drafts
and reloads the active workspace in other open tabs. The initiating tab reloads after the
administrator acknowledges the returned result. No erasure is performed merely by opening
the dialog. The unsupported selective-redaction button has been removed.

The JSON review export now includes saved reply/note drafts from all agents and customer/
ticket custom fields. It flags review_required and attachment_contents_included=false.
It is an administrator review bundle, not an automatically customer-ready response: it
may contain third-party/staff information, and attachment files need separate review and
secure delivery. Export/erasure responses use Cache-Control: no-store. Downloaded copies
are outside browser-cache cleanup.

## Browser drafts

Manual logout saves pending drafts in the active workspace before clearing this agent's
browser copies across workspaces and notifying other open tabs. Failed saves, conflicts,
and unsaved copies from other tabs/workspaces require staying signed in or explicitly
discarding unsaved browser work. Session expiry clears copies immediately; synced server
drafts can be restored after authenticated access succeeds. Late responses cannot rewrite
cleared caches. Confirmed customer erasure clears cached drafts for known tickets across
agents and tabs; denied draft reads/writes clear that agent's affected ticket cache.

A closed or offline browser cannot receive an erasure notification. It clears affected
copies when the app learns of erasure or access denial; cached text is hidden until access
is checked. This is not remote deletion from every device or browser backup. Legacy
unscoped browser drafts are cleared at logout/expiry. A stale unsaved-tab marker can
conservatively require explicit discard if its contents were overwritten in shared storage.

## Operational diagnostics

API request logs use registered route patterns, method, status and duration, never
raw URLs or query strings. Application failure logs use allowlisted error types/codes
and numeric status; provider messages, SQL details, customer identifiers, filenames
and sign-in links are omitted. The Better Auth logger follows the same policy.
Anthropic SDK logging is disabled; callers retain safe failure diagnostics. Respovia's
own browser-console warnings retain fixed operation messages without raw errors.
Operational deletion alerts report counts, not attachment keys or saved error text.
New object-deletion and webhook retry error records also omit raw exception text.

Sentry remains DSN-gated. Explicit reports are rebuilt from error types/codes and
event metadata; request data, arbitrary context, breadcrumbs, raw stacks/messages
and attachments are excluded. Automatic SDK integrations are disabled. This reduces
diagnostic detail deliberately; ordinary application logs retain the failing operation.

The production nginx access log retains status, duration and byte count only. Its
unstructured error log is disabled because it can include request URLs and IPs.
Use access-log status counts and deployment health checks to detect web failures.

This changes new diagnostics, not historical logs or backups. Reverse-proxy/CDN,
hosting and provider logging/retention require a separate operational review. Business
notifications, authorised audit records and customer-facing delivery errors are separate
data surfaces and are not covered by the diagnostic filtering described here.

## Erasure repair and remaining product-wide work

Migration `20261001140000_erasure_auxiliary_data.sql` repairs drafts, custom values and
webhook snapshots for customers already marked erased. The same cleanup runs atomically
when `erased_at` is set. It leaves other customers and workspaces unchanged. These
guards cover these three surfaces; they are not a product-wide ban on every possible
write to an erased ticket.

Still to assess/remediate: remaining export completeness and document review/delivery; legacy
historical S2 repair; remaining unattributed copies, infrastructure logs and business notification payloads; staff-data rights;
retention by data category; backup restore erasure replay; downstream recipient deletion;
processor contracts, locations/transfers, AI handling, privacy notices and DPIA needs.
Customer erasure is not a substitute for a staff-data rights process.

## Consumers of this inventory

- `feat/gdpr-erasure` — implemented in `api/src/lib/gdpr-erasure.ts` (this table is the contract).
- `feat/data-export` — DSAR export must surface every column above for the data subject.
- `feat/data-retention` — the purge job operates on the same tables (full delete past the
  retention window, vs. redaction here).
