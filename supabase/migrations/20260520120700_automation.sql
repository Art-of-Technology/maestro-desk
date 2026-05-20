-- Workflows: triggers + actions stored as structured JSON, not opaque strings.
-- This breaks from data.js (which had English-language trigger/action) so the
-- evaluator can actually run them without parsing prose.

create table workflows (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  display_id      text not null,
  name            text not null,
  trigger         jsonb not null,
  action          jsonb not null,
  status          text not null default 'active' check (status in ('active','inactive')),
  run_count       int not null default 0,
  last_run_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (workspace_id, display_id)
);

create trigger set_updated_at before update on workflows
  for each row execute function trigger_set_updated_at();

create table workflow_runs (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  workflow_id     uuid not null references workflows(id) on delete cascade,
  ticket_id       uuid references tickets(id) on delete set null,
  kind            text not null check (kind in ('manual','triggered')),
  triggered_by_user_id uuid references users(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index on workflow_runs (workflow_id, created_at desc);
create index on workflow_runs (workspace_id, created_at desc);

-- SLA policies — first response + resolution minutes per (priority, category).
-- NULL key means "any" for that dimension.
create table sla_policies (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  display_id      text not null,
  name            text not null,
  priority_key    text,
  category_key    text,
  first_response_min int not null,
  resolution_min  int not null,
  status          text not null default 'active' check (status in ('active','inactive')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (workspace_id, display_id)
);

create trigger set_updated_at before update on sla_policies
  for each row execute function trigger_set_updated_at();

-- Auto-assignment rules — evaluated in ascending priority order.
-- conditions JSON shape: {priority: 'all'|key, category: 'all'|key, vip: 'all'|tier}
-- assignment JSON shape: {mode: 'specific-agent'|'round-robin'|'least-busy',
--                         agent_user_id?: uuid, team_user_ids?: uuid[], rr_index?: int}
create table assign_rules (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  display_id      text not null,
  name            text not null,
  priority        int not null,
  status          text not null default 'active' check (status in ('active','inactive')),
  conditions      jsonb not null,
  assignment      jsonb not null,
  match_count     int not null default 0,
  last_match_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (workspace_id, display_id)
);

create index on assign_rules (workspace_id, status, priority);

create trigger set_updated_at before update on assign_rules
  for each row execute function trigger_set_updated_at();
