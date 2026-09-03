-- Maestro player identity on contacts.
--
-- maestro_user_id   — the player's GLOBAL Maestro id (userId in the member
--                     lookup), stable across brands.
-- maestro_member_id — the per-brand numeric member number. Stored as text so
--                     the merge/unmerge backfill journal (customer_merges.
--                     backfilled_fields, a {column: value} map compared back
--                     with equality on unmerge) keeps one code path for every
--                     backfillable column.
-- player_lookup_at  — when we last asked the gateway about this contact. A
--                     not-found answer is trusted for a day, so a non-player
--                     who emails ten times a day costs one lookup, not ten.
--
-- Both ids are personal data (they name a player account): lib/gdpr-erasure.ts
-- nulls them and lib/gdpr-export.ts includes them.
alter table customers
  add column if not exists maestro_user_id   text,
  add column if not exists maestro_member_id text,
  add column if not exists player_lookup_at  timestamptz;

-- Reverse lookup (player → local contact) for the SPA's "has this player
-- contacted support?" match and future duplicate detection.
create index if not exists customers_workspace_maestro_user
  on customers (workspace_id, maestro_user_id)
  where maestro_user_id is not null and deleted_at is null;
