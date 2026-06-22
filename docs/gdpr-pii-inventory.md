# GDPR PII Inventory — Maestro Desk

> Wave 2 of the compliance build-out (`IMPLEMENTATION-PLAN.md` Phase 4). This is the
> **shared spec** for erasure, data-subject export, and retention — enumerate every
> column that holds personal data of a *player/customer* (the data subject) once, so
> each of those features covers the same surfaces and none is missed.
> Grounded in `db/migrations/` as of 2026-06-22. Update when a new PII column lands.

A "data subject" here is a **customer** (player). Agent/operator accounts are users and
out of scope for customer erasure. The design intent (`20260520121300_gdpr.sql`): keep the
customer row + ticket rows so the audit trail and aggregate analytics survive, but **null /
redact the personal data** and stamp `customers.erased_at`.

## Surfaces

| Table | PII column(s) | Handling on erasure | Notes |
|---|---|---|---|
| `customers` | `first_name`, `last_name`, `username`, `email`, `mobile`, `backoffice_url`, `kyc_status`, `jurisdiction` | **null**; set `erased_at = now()` | Row kept (FKs from tickets). `display_id`, `brand`, `vip_tier`, `since`, `consent` retained as non-identifying / preference. |
| `customer_notes` | `text` (NOT NULL) | **delete rows** for the customer | Internal agent notes *about* the data subject — removed entirely. |
| `tickets` | `subject` (NOT NULL), `csat_comment`, `snooze_reason` | `subject → '[erased]'`; `csat_comment`, `snooze_reason → null` | Row kept; status/category/timestamps retained for analytics. |
| `ticket_messages` | `body` (NOT NULL), `author_label` | `body → '[erased]'`; `author_label → '[erased]'` only where `role = 'customer'` | Row kept (thread structure / audit). Agent/AI author labels are staff, not the data subject. |
| `inbox_messages` | `from_name`, `from_email`, `subject`, `body`, `body_html`, `raw` | **null** all | Matched by `converted_ticket_id ∈ customer's tickets` OR `from_email = customer.email`. |
| `gdpr_erasures` | — | **insert** the erasure record | `requested_by_user_id`, `completed_at`, `fields_erased[]`, `reason`. |

## Intentionally retained (by design)

- **`tickets` / `ticket_messages` rows** — kept (redacted) so the support history and the
  audit trail referencing the now-anonymous customer survive.
- **`events` / `audit_events`** — the activity/audit log is the tamper-evidence trail; it
  references the anonymized customer, not their content. (Read-access auditing +
  append-only hardening is the separate `feat/player-access-audit` item.)

## Deferred surfaces (tracked elsewhere)

- **`ticket_attachments` + the R2 objects** — inbound attachments are currently discarded
  (`lib/postmark.ts`) and uploads aren't wired, so no attachment PII is stored today. When
  attachments ship (`feat/secure-attachments`, gated on the owner decision), erasure must
  also delete the stored objects + rows.

## Consumers of this inventory

- `feat/gdpr-erasure` — implemented in `api/src/lib/gdpr-erasure.ts` (this table is the contract).
- `feat/data-export` — DSAR export must surface every column above for the data subject.
- `feat/data-retention` — the purge job operates on the same tables (full delete past the
  retention window, vs. redaction here).
