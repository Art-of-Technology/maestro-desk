create table kb_quality_findings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  article_id uuid not null references kb_articles(id) on delete cascade,
  fingerprint text not null,
  kind text not null check(kind in ('thin','duplicate','promotion','overdue','links','broken_links','unverified_links')),
  detail text not null,
  state text not null default 'open' check(state in ('open','reviewed','dismissed')),
  note text not null default '',
  reviewed_by uuid references users(id) on delete set null,
  reviewed_at timestamptz,
  detected_at timestamptz not null default now(),
  unique(article_id,fingerprint,kind)
);
create index kb_quality_queue on kb_quality_findings(workspace_id,state,detected_at desc,id);
create index kb_quality_article on kb_quality_findings(article_id);
create index kb_article_exact_copy on kb_articles(workspace_id,category,md5(body));
create index kb_article_owner on kb_articles(owner_user_id) where owner_user_id is not null;
