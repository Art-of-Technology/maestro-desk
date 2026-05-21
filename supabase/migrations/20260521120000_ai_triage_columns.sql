-- AI triage v1 — schema additions.
--
-- ai_summary and ai_draft_reply land on tickets as jsonb because the shape
-- is still evolving (we store the model + confidence + body + generated_at
-- alongside the text). Promote to relational columns once the shape stabilises.
--
-- ai_usage_log is the flat per-call cost ledger. ai_conversations + ai_messages
-- were designed for chat-style multi-turn use; one-shot triage doesn't fit
-- that model, so we log here instead.

alter table tickets
  add column ai_summary jsonb,
  add column ai_draft_reply jsonb;

create table ai_usage_log (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  ticket_id       uuid references tickets(id) on delete set null,
  user_id         uuid references users(id) on delete set null,
  action          text not null,                  -- 'triage' | 'summarize' | 'classify' | 'draft' | ...
  model           text not null,                  -- 'claude-sonnet-4-6' | 'claude-haiku-4-5' | ...
  input_tokens    int not null default 0,
  cache_creation_input_tokens int not null default 0,
  cache_read_input_tokens int not null default 0,
  output_tokens   int not null default 0,
  cost_usd_micro  bigint not null default 0,      -- integer micro-dollars
  duration_ms     int,
  request_id      text,                            -- Anthropic request_id for debugging
  created_at      timestamptz not null default now()
);

create index on ai_usage_log (workspace_id, created_at desc);
create index on ai_usage_log (workspace_id, action, created_at desc);
create index on ai_usage_log (ticket_id, created_at desc) where ticket_id is not null;

alter table ai_usage_log enable row level security;

-- Read-only to authenticated users; writes go through the API (service_role).
create policy ai_usage_log_ws_read on ai_usage_log
  for select to authenticated
  using (workspace_id = public.current_workspace_id());
