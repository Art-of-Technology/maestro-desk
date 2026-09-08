-- Administrative closure is distinct from a successful resolution.
alter table tickets
  add column closure_reason text check (closure_reason in ('spam', 'abuse', 'duplicate', 'other')),
  add column closure_note text,
  add column closed_at timestamptz,
  add column closed_by_user_id uuid references users(id) on delete set null,
  add constraint tickets_closed_reason check (status_key <> 'closed' or (closure_reason is not null and closed_at is not null));

insert into ticket_statuses (workspace_id, key, label, color, sort_order, is_terminal)
select id, 'closed', 'Closed', 'var(--ink3)', 100, true from workspaces
on conflict (workspace_id, key) do update set label = 'Closed', is_terminal = true;

-- Covers provisioning and workspaces created directly by integrations.
create function seed_closed_ticket_status() returns trigger language plpgsql as $$
begin
  insert into ticket_statuses (workspace_id, key, label, color, sort_order, is_terminal)
  values (new.id, 'closed', 'Closed', 'var(--ink3)', 100, true);
  return new;
end;
$$;
create trigger seed_closed_ticket_status after insert on workspaces
for each row execute function seed_closed_ticket_status();
