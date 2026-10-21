create table ticket_close_reminders (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  ticket_id uuid not null references tickets(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  pending boolean not null default false,
  version integer not null default 0 check (version >= 0),
  primary key (workspace_id, ticket_id, user_id)
);

-- Retain cleared versions so a disconnected device cannot restore an old reminder.
create function clear_ticket_close_reminders() returns trigger language plpgsql as $$
begin
  if new.status_key = 'closed' or new.merged_into_id is not null or new.deleted_at is not null then
    update ticket_close_reminders set pending = false, version = version + 1
      where workspace_id = new.workspace_id and ticket_id = new.id and pending;
  end if;
  return new;
end;
$$;
create trigger clear_ticket_close_reminders after update of status_key, merged_into_id, deleted_at on tickets
  for each row execute function clear_ticket_close_reminders();
