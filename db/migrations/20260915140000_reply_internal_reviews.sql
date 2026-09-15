-- Agent-only evidence stays outside the customer message and delivery payloads.
create table reply_internal_reviews (
  message_id uuid primary key references ticket_messages(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  review jsonb not null check (jsonb_typeof(review) = 'object'),
  saved_at timestamptz not null default now()
);
create index on reply_internal_reviews(workspace_id);
alter table reply_internal_reviews enable row level security;
-- Backend connections use the service role; no customer-facing RLS policy.
