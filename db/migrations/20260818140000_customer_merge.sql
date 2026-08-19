-- Server-side customer-profile merge (Phase 2, PR 3).
--
-- Mirrors the ticket-merge shape (tickets.merged_into_id/merged_at,
-- 20260520120500): a merged source customer points at its survivor and is
-- hidden from the default list; every moved ticket/note carries a stamp so
-- unmerge can put things back; and a customer_merges journal row records
-- what happened (including which blank survivor fields were backfilled from
-- the source, so unmerge can revert exactly those — and only where the
-- survivor hasn't edited them since). The journal row is permanent history:
-- unmerge stamps it rather than deleting it.

alter table customers
  add column if not exists merged_into_customer_id uuid references customers(id),
  add column if not exists merged_at timestamptz;

create index if not exists customers_merged_into_idx
  on customers (workspace_id, merged_into_customer_id)
  where merged_into_customer_id is not null;

-- Which customer each ticket belonged to before a merge moved it. NULL for
-- tickets never touched by a customer merge; cleared again on unmerge.
alter table tickets
  add column if not exists pre_merge_customer_id uuid references customers(id);

-- Which customer a note came from when a merge moved it to the survivor.
-- NULL for notes born on their current customer; cleared again on unmerge.
alter table customer_notes
  add column if not exists merged_from_customer_id uuid references customers(id);

create table if not exists customer_merges (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  source_customer_id  uuid not null references customers(id),
  primary_customer_id uuid not null references customers(id),
  merged_by_user_id   uuid references users(id) on delete set null,
  merged_at           timestamptz not null default now(),
  tickets_moved       int not null default 0,
  notes_moved         int not null default 0,
  -- {column: value_copied_from_source} — the unmerge's memory for the
  -- conditional backfill revert.
  backfilled_fields   jsonb not null default '{}'::jsonb,
  unmerged_at         timestamptz,
  unmerged_by_user_id uuid references users(id) on delete set null
);

create index if not exists customer_merges_source_idx
  on customer_merges (workspace_id, source_customer_id);
