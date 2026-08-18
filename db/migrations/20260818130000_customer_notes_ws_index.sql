-- The workspace-wide notes list (GET /api/v1/customers/notes, loaded once per
-- bootstrap) filters by workspace_id and orders by created_at desc. The table
-- only had a per-customer index (customer_id FK); give the bootstrap query a
-- matching composite so it stays an index scan as note volume grows.
create index if not exists customer_notes_workspace_created_idx
  on customer_notes (workspace_id, created_at desc);
