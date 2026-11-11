-- Revisions detect edits and remove/re-add operations, even when values match.
alter table tag_library add column revision uuid not null default gen_random_uuid();
alter table ticket_tags add column revision uuid not null default gen_random_uuid();
alter table ticket_ai_tags add column revision uuid not null default gen_random_uuid();

create function refresh_tag_revision() returns trigger language plpgsql as $$
begin
  new.revision := gen_random_uuid();
  return new;
end;
$$;
create trigger tag_library_revision before update on tag_library for each row execute function refresh_tag_revision();
create trigger ticket_tags_revision before update on ticket_tags for each row execute function refresh_tag_revision();
create trigger ticket_ai_tags_revision before update on ticket_ai_tags for each row execute function refresh_tag_revision();

create table tag_merges (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  source text not null,
  target text not null,
  source_kind text not null,
  source_confidence smallint,
  target_revision uuid not null,
  assignment_count integer not null,
  created_at timestamptz not null default now(),
  undone_at timestamptz
);
create index on tag_merges(workspace_id, created_at desc);

create table tag_merge_assignments (
  merge_id uuid not null references tag_merges(id) on delete cascade,
  ticket_id uuid not null references tickets(id) on delete cascade,
  kind text not null check (kind in ('manual', 'ai')),
  source_confidence smallint,
  source_accepted boolean,
  source_created_at timestamptz,
  had_target boolean not null,
  target_revision uuid not null,
  primary key (merge_id, ticket_id, kind)
);
create index on tag_merge_assignments(ticket_id);
