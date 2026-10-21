alter table tickets add column close_reminder_generation integer not null default 0;

-- Invalidate offline edits even if an agent has not saved their first marker yet.
drop trigger clear_ticket_close_reminders on tickets;
create or replace function clear_ticket_close_reminders() returns trigger language plpgsql as $$
begin
  if new.status_key = 'closed' or new.merged_into_id is not null or new.deleted_at is not null then
    new.close_reminder_generation := old.close_reminder_generation + 1;
    update ticket_close_reminders set pending = false, version = version + 1
      where workspace_id = new.workspace_id and ticket_id = new.id;
  end if;
  return new;
end;
$$;
create trigger clear_ticket_close_reminders before update of status_key, merged_into_id, deleted_at on tickets
  for each row execute function clear_ticket_close_reminders();
