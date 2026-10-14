-- In-flight work must not resume silently after a suspend/reactivate cycle.
alter table workspaces add column suspension_generation bigint not null default 0;

create function bump_workspace_suspension_generation() returns trigger language plpgsql as $$
begin
  if new.suspended_at is distinct from old.suspended_at then
    new.suspension_generation := old.suspension_generation + 1;
  end if;
  return new;
end;
$$;

create trigger workspace_suspension_generation before update of suspended_at on workspaces
for each row execute function bump_workspace_suspension_generation();
