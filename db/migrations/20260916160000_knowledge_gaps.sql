create table kb_knowledge_gaps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  group_key text not null,
  category text,
  brand text,
  market text,
  state text not null default 'open' check (state in ('open','in_progress','resolved','dismissed')),
  article_id uuid references kb_articles(id) on delete set null,
  note text not null default '' check (length(note)<=2000),
  scanned_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 0,
  unique(workspace_id,group_key)
);
create index on kb_knowledge_gaps(workspace_id,state,scanned_at desc);
create index on kb_knowledge_gaps(article_id) where article_id is not null;
create table kb_knowledge_gap_tickets (
  gap_id uuid not null references kb_knowledge_gaps(id) on delete cascade,
  ticket_id uuid not null references tickets(id) on delete cascade,
  signal text not null check (signal in ('unanswered','negative_feedback','both')),
  primary key(gap_id,ticket_id)
);
create index on kb_knowledge_gap_tickets(ticket_id);
