-- GDPR erasure log. Tracks which customer fields were nulled on which date,
-- and by whom. Tickets keep referencing the (now-anonymous) customer so the
-- audit trail and aggregate analytics survive.

create table gdpr_erasures (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  customer_id     uuid not null references customers(id),
  requested_by_user_id uuid references users(id) on delete set null,
  requested_at    timestamptz not null default now(),
  completed_at    timestamptz,
  fields_erased   text[],
  reason          text
);

create index on gdpr_erasures (workspace_id, requested_at desc);
create index on gdpr_erasures (customer_id, requested_at desc);
