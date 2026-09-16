alter table kb_articles
  add column owner_user_id uuid references users(id) on delete set null,
  add column review_due_date date,
  add column reviewed_at timestamptz;

create index kb_articles_review_due on kb_articles(workspace_id, review_due_date)
  where review_due_date is not null;
