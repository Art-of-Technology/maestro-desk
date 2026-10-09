-- Non-empty origins identify forwards even after email metadata is erased.
alter table ticket_messages add column forwarded_from_ticket_ids uuid[] not null default '{}';
create index ticket_forward_origins on ticket_messages using gin(forwarded_from_ticket_ids) where cardinality(forwarded_from_ticket_ids)>0;

create or replace function assert_ticket_content(ws uuid, ticket_ids uuid[]) returns void language plpgsql as $$
declare subject record;
begin
  if exists(select 1 from unnest(ticket_ids) requested(id) where not exists
    (select 1 from tickets t where t.id=requested.id and t.workspace_id=ws)) then
    raise exception 'Ticket is unavailable' using errcode='23514', constraint='customer_erased';
  end if;
  -- Include the origin of merged copies, not just the current ticket owner.
  for subject in select c.id,c.erased_at from customers c join (
    select t.customer_id from tickets t where t.workspace_id=ws and t.id=any(ticket_ids)
    union
    select t.pre_merge_customer_id from tickets t where t.workspace_id=ws and t.id=any(ticket_ids)
      and t.pre_merge_customer_id is not null
    union
    select origin.customer_id from ticket_messages m join tickets origin
      on origin.id=m.merged_from_id and origin.workspace_id=m.workspace_id
      where m.workspace_id=ws and m.ticket_id=any(ticket_ids) and m.body <> '[erased]'
    union
    select origin.customer_id from ticket_messages m join tickets origin
      on origin.id=any(m.forwarded_from_ticket_ids) and origin.workspace_id=m.workspace_id
      where m.workspace_id=ws and m.ticket_id=any(ticket_ids) and m.body <> '[erased]'
  ) owners on owners.customer_id=c.id where c.workspace_id=ws
  order by c.id for share of c nowait loop
    if subject.erased_at is not null then
      raise exception 'Customer has been erased' using errcode='23514', constraint='customer_erased';
    end if;
  end loop;
end $$;

create function guard_forwarded_email() returns trigger language plpgsql as $$
begin
  if cardinality(new.forwarded_from_ticket_ids)>0 and new.body <> '[erased]' then
    perform assert_ticket_content(new.workspace_id, new.forwarded_from_ticket_ids);
  end if;
  return new;
end $$;
create trigger ticket_forward_privacy before insert or update on ticket_messages
  for each row execute function guard_forwarded_email();
-- Rollback requires restoring assert_ticket_content from 20261005110000 first,
-- then dropping ticket_forward_privacy, guard_forwarded_email and the column.
