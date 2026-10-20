alter table ticket_statuses
  add column reason_required boolean not null default false,
  add column reasons jsonb not null default '[]'::jsonb;
update ticket_statuses set reason_required = true,
  reasons = '[{"key":"spam","label":"Spam","is_active":true},{"key":"abuse","label":"Abuse","is_active":true},{"key":"duplicate","label":"Duplicate","is_active":true},{"key":"other","label":"Other","is_active":true}]'
where base_key = 'closed';

-- New brands use legacy seed inserts, so supply the same closure defaults.
create function default_ticket_status_reasons() returns trigger language plpgsql as $$
begin
  if new.key = 'closed' and new.reasons = '[]'::jsonb then
    new.reason_required := true;
    new.reasons := '[{"key":"spam","label":"Spam","is_active":true},{"key":"abuse","label":"Abuse","is_active":true},{"key":"duplicate","label":"Duplicate","is_active":true},{"key":"other","label":"Other","is_active":true}]';
  end if;
  return new;
end;
$$;
create trigger ticket_status_reason_defaults before insert on ticket_statuses
for each row execute function default_ticket_status_reasons();

alter table tickets
  drop constraint tickets_closure_reason_check,
  drop constraint tickets_closed_reason,
  add constraint tickets_closed_metadata check (status_key <> 'closed' or closed_at is not null),
  add column status_reason text,
  add column status_reason_label text;
update tickets set status_reason = closure_reason,
  status_reason_label = initcap(closure_reason) where closure_reason is not null;

create function guard_ticket_status_reason_content() returns trigger language plpgsql as $$
declare subject record;
begin
  if new.status_reason_label is null then return new; end if;
  if tg_op = 'INSERT' then
    for subject in select erased_at from customers where workspace_id=new.workspace_id
      and id in (new.customer_id,new.pre_merge_customer_id) order by id for share nowait loop
      if subject.erased_at is not null then
        raise exception 'Customer has been erased' using errcode='23514', constraint='customer_erased';
      end if;
    end loop;
  elsif new.status_reason_label is distinct from old.status_reason_label then
    perform assert_ticket_content(new.workspace_id, array[new.id]);
  end if;
  return new;
end;
$$;
create trigger ticket_status_reason_privacy before insert or update of status_reason_label on tickets
for each row execute function guard_ticket_status_reason_content();
