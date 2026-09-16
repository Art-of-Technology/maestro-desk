alter table ai_reply_feedback
  add column resolution_status text not null default 'open' check (resolution_status in ('open','in_progress','resolved')),
  add column owner_user_id uuid references users(id) on delete set null,
  add column root_cause text check (root_cause in ('knowledge_gap','outdated_knowledge','wrong_match','language','generation','other')),
  add column resolution_notes text not null default '' check (length(resolution_notes)<=2000),
  add column resolution_updated_at timestamptz,
  add column resolution_updated_by uuid references users(id) on delete set null,
  add column resolution_version integer not null default 0;
create index on ai_reply_feedback(owner_user_id) where owner_user_id is not null;
create index on ai_reply_feedback(resolution_updated_by) where resolution_updated_by is not null;
