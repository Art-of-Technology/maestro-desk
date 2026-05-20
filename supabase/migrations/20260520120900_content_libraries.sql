-- Canned responses (macros) — text snippets agents insert into replies.
create table canned_responses (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  display_id      text not null,
  name            text not null,
  category        text,
  body            text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (workspace_id, display_id)
);

create trigger set_updated_at before update on canned_responses
  for each row execute function trigger_set_updated_at();

-- Ticket templates — pre-filled subject/body/priority for common ticket types.
create table ticket_templates (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  display_id      text not null,
  name            text not null,
  category        text,
  priority_key    text,
  subject         text,
  body            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (workspace_id, display_id)
);

create trigger set_updated_at before update on ticket_templates
  for each row execute function trigger_set_updated_at();

-- Knowledge base articles. status tracks the publication lifecycle so drafts
-- (incl. AI-auto-drafted-from-resolved-tickets) can sit awaiting review.
create table kb_articles (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  display_id      text not null,
  title           text not null,
  category        text,
  body            text not null,
  author_user_id  uuid references users(id) on delete set null,
  status          text not null default 'published' check (status in ('draft','published','archived')),
  view_count      int not null default 0,
  helpful_count   int not null default 0,
  unhelpful_count int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (workspace_id, display_id)
);

create index on kb_articles (workspace_id, status, updated_at desc);

create trigger set_updated_at before update on kb_articles
  for each row execute function trigger_set_updated_at();

-- KB votes — supports both authenticated agents (user_key = user_id::text)
-- and anonymous portal visitors (user_key = hashed identifier).
create table kb_votes (
  workspace_id    uuid not null,
  article_id      uuid not null references kb_articles(id) on delete cascade,
  user_key        text not null,
  vote            smallint not null check (vote in (-1, 1)),
  created_at      timestamptz not null default now(),
  primary key (article_id, user_key)
);
