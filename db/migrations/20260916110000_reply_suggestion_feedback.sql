create table ai_reply_suggestions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  ticket_id uuid not null references tickets(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  reply text not null check (length(reply) <= 20000),
  created_at timestamptz not null default now()
);
create index on ai_reply_suggestions(ticket_id);
create index on ai_reply_suggestions(workspace_id);
create table ai_reply_suggestion_sources (
  suggestion_id uuid not null references ai_reply_suggestions(id) on delete cascade,
  ticket_id uuid not null references tickets(id) on delete cascade,
  primary key(suggestion_id, ticket_id)
);
create index on ai_reply_suggestion_sources(ticket_id);
create table ai_reply_feedback (
  suggestion_id uuid primary key references ai_reply_suggestions(id) on delete cascade,
  helpful boolean not null,
  reason text check (reason in ('wrong_match','outdated_advice','wrong_language','other')),
  updated_at timestamptz not null default now(),
  check (not helpful or reason is null)
);

-- Suggestions may contain customer details. Purge snapshots and ratings when
-- their target or any historical source is removed, merged or erased.
create function purge_ticket_reply_suggestions() returns trigger language plpgsql as $$
begin
  delete from ai_reply_suggestions s where s.ticket_id=old.id
    or s.id in (select suggestion_id from ai_reply_suggestion_sources where ticket_id=old.id);
  return old;
end $$;
create trigger reply_suggestions_ticket_delete before delete on tickets
  for each row execute function purge_ticket_reply_suggestions();
create trigger reply_suggestions_ticket_remove after update of deleted_at,merged_into_id,customer_id on tickets
  for each row when (new.deleted_at is not null or new.merged_into_id is not null or old.customer_id is distinct from new.customer_id)
  execute function purge_ticket_reply_suggestions();

create function purge_customer_reply_suggestions() returns trigger language plpgsql as $$
begin
  delete from ai_reply_suggestions s where s.ticket_id in (select id from tickets where customer_id=new.id)
    or s.id in (select x.suggestion_id from ai_reply_suggestion_sources x
      join tickets t on t.id=x.ticket_id where t.customer_id=new.id);
  return new;
end $$;
create trigger reply_suggestions_customer_remove after update of deleted_at,erased_at on customers
  for each row when (new.deleted_at is not null or new.erased_at is not null)
  execute function purge_customer_reply_suggestions();
