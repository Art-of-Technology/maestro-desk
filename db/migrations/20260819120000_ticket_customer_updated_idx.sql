-- Composite index for the per-customer profile queries (Phase 4).
--
-- The customer profile pages a customer's tickets newest-first and derives its
-- activity window the same way. The two existing indexes each serve half of
-- that and neither serves both:
--
--   tickets (workspace_id, customer_id) where deleted_at is null   -- the filter
--   tickets (workspace_id, updated_at desc) where deleted_at is null -- the sort
--
-- So `where workspace_id = ? and customer_id = ?  order by updated_at desc
-- limit 25` fetches every one of that customer's tickets and top-N sorts them,
-- and page 0's count(*) over() pushes all of them through a WindowAgg on top.
-- For a customer with a long history that is several full passes over their
-- tickets on every profile open.
--
-- This makes both the paged list and the activity window a bounded index scan,
-- and it also gives the tag rollup an efficient way in.
--
-- id is the LAST index column, not an afterthought: the queries order by
-- (updated_at desc, id desc) — the id tie-break keeps offset paging
-- deterministic when a batch of tickets shares an updated_at, which a customer
-- merge produces routinely. Without id in the index the planner can satisfy
-- the filter from it but must still sort, which is most of what this is for.
--
-- Partial on deleted_at to match the predicate every one of those queries
-- carries, and to stay consistent with the two indexes above.
--
-- Not created concurrently: the migration runner wraps each file in a
-- transaction (api/scripts/migrate.ts) and CREATE INDEX CONCURRENTLY cannot run
-- inside one. Acceptable here — this locks writes to `tickets` only for as long
-- as the build takes, and it runs at container boot before traffic is served.

create index if not exists tickets_workspace_customer_updated_idx
  on tickets (workspace_id, customer_id, updated_at desc, id desc)
  where deleted_at is null;
