-- AI conversation history. Was: localStorage 'ai_conversations' / 'ai_current_id'
-- in js/ai/page.js, scoped per-user. Optionally tied to a ticket (when launched
-- from the ticket detail AI sidebar).

create table ai_conversations (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  title           text,
  ticket_id       uuid references tickets(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index on ai_conversations (user_id, updated_at desc);
create index on ai_conversations (workspace_id, created_at desc);

create trigger set_updated_at before update on ai_conversations
  for each row execute function trigger_set_updated_at();

-- Each turn of an AI conversation, plus token/cost tracking for workspace budgets.
-- cost_usd_micro is integer micro-dollars to avoid floating point in cost ledgers.
create table ai_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references ai_conversations(id) on delete cascade,
  workspace_id    uuid not null,
  role            text not null check (role in ('user','assistant','system')),
  body            text not null,
  model           text,
  token_count_in  int,
  token_count_out int,
  cost_usd_micro  bigint,
  created_at      timestamptz not null default now()
);

create index on ai_messages (conversation_id, created_at);
create index on ai_messages (workspace_id, created_at desc);
