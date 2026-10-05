-- Controls only: historical repair is an explicit, separately approved operation.
alter table tickets add column privacy_generation bigint not null default 0;
alter table workspaces add column privacy_generation bigint not null default 0;

create function assert_ticket_content(ws uuid, ticket_ids uuid[]) returns void language plpgsql as $$
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
  ) owners on owners.customer_id=c.id where c.workspace_id=ws
  order by c.id for share of c nowait loop
    if subject.erased_at is not null then
      raise exception 'Customer has been erased' using errcode='23514', constraint='customer_erased';
    end if;
  end loop;
end $$;

create function guard_ticket_personal_content() returns trigger language plpgsql as $$
declare row_data jsonb := to_jsonb(new); ids uuid[]; subject_erased timestamptz;
begin
  if tg_table_name='tickets' then
    -- Privacy cleanup and later non-content updates must remain possible.
    if tg_op='UPDATE' and new.customer_id=old.customer_id
      and new.ai_summary is null and new.ai_draft_reply is null
      and (to_jsonb(new)-array['ai_summary','ai_draft_reply','privacy_generation','updated_at']) =
          (to_jsonb(old)-array['ai_summary','ai_draft_reply','privacy_generation','updated_at']) then return new; end if;
    if new.subject='[erased]' and new.ai_summary is null and new.ai_draft_reply is null
      and new.csat_comment is null and new.snooze_reason is null and new.closure_note is null
      and new.last_inbound_email is null then return new; end if;
    for subject_erased in select erased_at from customers where id in (new.customer_id,new.pre_merge_customer_id)
      and workspace_id=new.workspace_id order by id for share nowait loop
      if subject_erased is not null then
        raise exception 'Customer has been erased' using errcode='23514', constraint='customer_erased';
      end if;
    end loop;
    if tg_op='UPDATE' then perform assert_ticket_content(new.workspace_id,array[new.id]); end if;
    return new;
  elsif tg_table_name='customer_notes' then
    for subject_erased in select c.erased_at from customers c where c.workspace_id=new.workspace_id
      and c.id in (new.customer_id,new.merged_from_customer_id) order by c.id for share nowait loop
      if subject_erased is not null then
        raise exception 'Customer has been erased' using errcode='23514', constraint='customer_erased';
      end if;
    end loop;
    return new;
  elsif tg_table_name='reply_internal_reviews' then
    select array[m.ticket_id,m.merged_from_id] into ids from ticket_messages m
      where m.id=new.message_id and m.workspace_id=new.workspace_id;
  else
    if tg_table_name='time_entries' and row_data->>'note' is null then return new; end if;
    if tg_table_name='ticket_messages' and row_data->>'body'='[erased]'
      and row_data->>'body_html' is null and row_data->>'email_metadata' is null
      and (row_data->>'role'<>'customer' or row_data->>'author_label'='[erased]') then return new; end if;
    ids := array[(row_data->>'ticket_id')::uuid,(row_data->>'merged_from_id')::uuid];
  end if;
  perform assert_ticket_content((row_data->>'workspace_id')::uuid,array_remove(ids,null));
  return new;
end $$;

create trigger ticket_personal_content_guard before insert or update of subject,customer_id,pre_merge_customer_id,ai_summary,ai_draft_reply,
  csat_comment,snooze_reason,last_inbound_email,closure_note on tickets
  for each row execute function guard_ticket_personal_content();
do $$ declare tab text; begin
  foreach tab in array array['ticket_messages','ticket_attachments','ticket_tags','ticket_ai_tags',
    'time_entries','reply_internal_reviews','customer_notes','ai_reply_suggestions'] loop
    execute format('create trigger ticket_personal_content_guard before insert or update on %I for each row execute function guard_ticket_personal_content()',tab);
  end loop;
end $$;

create function ticket_privacy_owner_changed() returns trigger language plpgsql as $$
begin
  if new.customer_id is distinct from old.customer_id or new.merged_into_id is distinct from old.merged_into_id
    or new.pre_merge_customer_id is distinct from old.pre_merge_customer_id then
    -- Bounded sends hold a customer share lock. Ownership changes must not
    -- overtake them; ordinary ticket status/claim updates remain independent.
    perform id from customers where workspace_id=new.workspace_id and id in (old.customer_id,new.customer_id)
      order by id for update nowait;
    new.privacy_generation := old.privacy_generation+1;
  end if;
  return new;
end $$;
create trigger ticket_privacy_owner_changed before update of customer_id,merged_into_id,pre_merge_customer_id on tickets
  for each row execute function ticket_privacy_owner_changed();
