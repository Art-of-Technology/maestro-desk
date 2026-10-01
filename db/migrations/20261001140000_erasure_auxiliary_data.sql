-- Erasure keeps customer/ticket rows, so their auxiliary content needs explicit cleanup.
create function erase_customer_auxiliary_data(ws uuid, subject_id uuid) returns void
language plpgsql as $$
begin
  delete from message_drafts d using tickets t
    where d.workspace_id=ws and t.workspace_id=ws and d.ticket_id=t.id and t.customer_id=subject_id;
  delete from custom_field_values v where v.workspace_id=ws and (
    (v.entity_type='customer' and v.entity_id=subject_id) or
    (v.entity_type='ticket' and v.entity_id in (select id from tickets where workspace_id=ws and customer_id=subject_id))
  );
  delete from webhook_deliveries d where d.workspace_id=ws and (
    d.payload->'customer'->>'id'=subject_id::text or
    d.payload->'ticket'->>'id' in (select id::text from tickets where workspace_id=ws and customer_id=subject_id)
  );
end $$;

create function erase_customer_auxiliary_trigger() returns trigger language plpgsql as $$
begin
  perform erase_customer_auxiliary_data(new.workspace_id,new.id);
  return new;
end $$;
create trigger customer_erasure_auxiliary after update of erased_at on customers
  for each row when (new.erased_at is not null) execute function erase_customer_auxiliary_trigger();

-- Serialize content writes against erasure, including old application instances.
-- FOR SHARE conflicts with erasure's customer lock; a waiting writer sees erased_at.
create function guard_erased_customer_content() returns trigger language plpgsql as $$
declare subject_erased timestamptz;
begin
  if tg_table_name='message_drafts' then
    -- Sending clears an existing draft; an empty tombstone cannot restore content.
    if new.body='' and new.recipients is null and new.review is null and cardinality(new.attachment_ids)=0 then
      return new;
    end if;
    select c.erased_at into subject_erased from customers c join tickets t
      on t.customer_id=c.id and t.workspace_id=c.workspace_id
      where t.id=new.ticket_id and c.workspace_id=new.workspace_id for share of c;
  elsif tg_table_name='custom_field_values' then
    select c.erased_at into subject_erased from customers c where c.workspace_id=new.workspace_id and (
      (new.entity_type='customer' and c.id=new.entity_id) or
      (new.entity_type='ticket' and exists(select 1 from tickets t where t.id=new.entity_id
        and t.workspace_id=c.workspace_id and t.customer_id=c.id))
    ) for share of c;
  else
    -- Match both identities: a copied payload can name a different historical customer.
    for subject_erased in select c.erased_at from customers c where c.workspace_id=new.workspace_id and (
      c.id::text=new.payload->'customer'->>'id' or exists(select 1 from tickets t
        where t.id::text=new.payload->'ticket'->>'id' and t.workspace_id=c.workspace_id and t.customer_id=c.id)
    ) order by c.id for share of c loop
      if subject_erased is not null then
        raise exception 'Customer has been erased' using errcode='23514', constraint='customer_erased';
      end if;
    end loop;
    return new;
  end if;
  if subject_erased is not null then
    raise exception 'Customer has been erased' using errcode='23514', constraint='customer_erased';
  end if;
  return new;
end $$;
create trigger draft_customer_erasure_guard before insert or update on message_drafts
  for each row execute function guard_erased_customer_content();
create trigger custom_value_customer_erasure_guard before insert or update on custom_field_values
  for each row execute function guard_erased_customer_content();
create trigger webhook_customer_erasure_guard before insert or update of payload on webhook_deliveries
  for each row execute function guard_erased_customer_content();

-- Repair only already-erased subjects; preserve active customers and their content.
select erase_customer_auxiliary_data(workspace_id,id) from customers where erased_at is not null;
