-- Keep the latest queue event even when several edits happen between syncs.
alter table tickets add column queue_assignment_at timestamptz;
alter table tickets add column queue_reopened_at timestamptz;

create function stamp_ticket_queue_events() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.assigned_user_id is not null then new.queue_assignment_at = clock_timestamp(); end if;
  else
    if new.assigned_user_id is distinct from old.assigned_user_id then
      new.queue_assignment_at = case when new.assigned_user_id is not null then clock_timestamp() end;
    end if;
    if old.status_key in ('closed', 'resolved') and new.status_key in ('open', 'pending', 'escalated', 'gdpr') then
      new.queue_reopened_at = clock_timestamp();
    end if;
  end if;
  return new;
end;
$$;

-- Run after status-option normalisation so custom status choices use their base category.
create trigger zz_ticket_queue_events before insert or update on tickets
  for each row execute function stamp_ticket_queue_events();
