-- Customer notes go read/write via the API (Phase 2): soft-delete support +
-- an index for the new workspace-wide list.
--
-- deleted_at brings individual note deletion in line with the codebase's
-- soft-delete convention (tickets, customers, channels, …): the row stays
-- for recoverability and the audit row is the trail. The two deliberate
-- HARD-delete paths remain: GDPR erasure, and the profile-delete purge
-- (PII must not outlive a deleted profile).
alter table customer_notes
  add column if not exists deleted_at timestamptz;

-- The workspace-wide notes list (GET /api/v1/customers/notes, loaded once per
-- bootstrap) filters by workspace_id and orders by created_at desc. The table
-- only had a per-customer index (customer_id FK); give the bootstrap query a
-- matching composite so it stays an index scan as note volume grows.
create index if not exists customer_notes_workspace_created_idx
  on customer_notes (workspace_id, created_at desc)
  where deleted_at is null;
