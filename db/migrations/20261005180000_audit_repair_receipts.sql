-- Evidence of an explicitly approved integrity transition, not a claim that
-- historical content was always minimised. External custody remains necessary.
create table audit_repair_receipts (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  proposal_hash text not null check (proposal_hash ~ '^[0-9a-f]{64}$'),
  receipt jsonb not null,
  created_at timestamptz not null default now()
);
revoke all on audit_repair_receipts from public;
create trigger audit_repair_receipts_no_update before update on audit_repair_receipts
  for each row execute function audit_events_immutable();
create trigger audit_repair_receipts_no_delete before delete on audit_repair_receipts
  for each row execute function audit_events_immutable();
-- No runtime grant and no elevated repair function. The owner-only CLI performs
-- the bounded transaction; the runtime grant installer excludes this table.
