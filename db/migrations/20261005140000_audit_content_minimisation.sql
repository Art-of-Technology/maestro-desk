-- Prospective controls only. Existing audit hashes and metadata are untouched.
-- Unknown metadata is discarded rather than made permanent by a new writer.
create function audit_metadata_facts(action_name text, data jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog,public as $$
declare result jsonb := '{}'; item record; value text; field text; cleaned jsonb;
  uuid_pattern constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  field_names constant text[] := array['first_name','last_name','username','email','mobile','backoffice_url',
    'kyc_status','jurisdiction','maestro_user_id','maestro_member_id','vip_tier','consent','since','is_spam',
    'name','address','type','active','role_id','suspended_at','deleted_at','retention_days',
    'ai_enabled','auto_reply_min_confidence','auto_reply_categories','default_priority','default_category',
    'contacts','tickets.last_inbound_email','tickets.closure_note','note_revisions','ticket_messages.email_metadata',
    'message_drafts','custom_field_values','webhook_deliveries','tickets.ai_summary','tickets.ai_draft_reply',
    'ticket_tags','ticket_ai_tags','time_entries.note','merged_message_copies','reply_internal_reviews','events'];
begin
  if jsonb_typeof(data) is distinct from 'object' then return result; end if;
  for item in select * from jsonb_each(data) loop
    value := item.value #>> '{}';
    if item.key=any(array['event_id','customer_id','original_customer_id','ticket_id','revision_id','author_user_id','contact_id',
      'role_id','invited_user_id','brand_id','domain_id','reclaimed_by_workspace','intended_workspace_id','into','from'])
      and jsonb_typeof(item.value)='string' and value ~ uuid_pattern then
      result := result || jsonb_build_object(item.key,value);
    elsif item.key=any(array['tickets','notes','inbox_messages','notes_deleted','tickets_moved','notes_moved',
      'contacts_moved','tickets_restored','notes_restored','contacts_restored','tickets_affected','messages_redacted',
      'inbox_redacted','attachments_deleted','previous_length','length','postmark_domain_id'])
      and jsonb_typeof(item.value)='number' and value ~ '^[0-9]+$' then
      result := result || jsonb_build_object(item.key,item.value);
    elsif item.key=any(array['blank','email_sent','primary']) and jsonb_typeof(item.value)='boolean' then
      result := result || jsonb_build_object(item.key,item.value);
    elsif item.key='source' and value=any(array['agent','customer_reply','assignment_rule','snooze_expired','close','merge','unmerge']) then
      result := result || jsonb_build_object(item.key,value);
    elsif item.key='reason' and value=any(array['subject_request','retention_expired','consent_withdrawn','other',
      'pre-erasure','inbound_email','contact_edit','profile_open','backfill','from_player','workspace_unavailable']) then
      result := result || jsonb_build_object(item.key,value);
    elsif item.key='kind' and value=any(array['email','mobile']) then
      result := result || jsonb_build_object(item.key,value);
    elsif item.key='lookup_key' and value=any(array['userId','email','username','memberId']) then
      result := result || jsonb_build_object(item.key,value);
    elsif item.key=any(array['before','after']) then
      if item.value='null'::jsonb or
        (action_name='ticket.status.changed' and value=any(array['open','pending','escalated','gdpr','resolved','closed'])) or
        (action_name='ticket.priority.changed' and value=any(array['low','normal','high','urgent'])) or
        (action_name=any(array['ticket.agent.changed','ticket.inbox.changed']) and value ~ uuid_pattern) then
        result := result || jsonb_build_object(item.key,item.value);
      elsif action_name='ticket.tag.changed' then
        result := result || jsonb_build_object(item.key,case when item.value='null'::jsonb then null else '[tag]' end);
      elsif action_name='ticket.snooze.changed' then
        -- Keep only whether a snooze existed. Its reason stays in erasable activity.
        result := result || jsonb_build_object(item.key,true);
      end if;
    elsif item.key='context' and jsonb_typeof(item.value)='object' then
      cleaned := '{}';
      foreach field in array array['rule_id','primary_id'] loop
        if item.value->>field ~ uuid_pattern then cleaned := cleaned || jsonb_build_object(field,item.value->>field); end if;
      end loop;
      if item.value->>'reason'=any(array['spam','abuse','duplicate','other']) then
        cleaned := cleaned || jsonb_build_object('reason',item.value->>'reason');
      end if;
      result := result || jsonb_build_object('context',cleaned);
    elsif item.key=any(array['changed_fields','changed_pii','fields','backfilled','fields_reverted',
      'fields_kept_due_to_edit','fields_skipped','fields_erased','accessed']) and jsonb_typeof(item.value)='array' then
      select coalesce(jsonb_agg(v), '[]') into cleaned from jsonb_array_elements(item.value) v
        where jsonb_typeof(v)='string' and (v #>> '{}')=any(case when item.key='accessed'
          then array['contact','vip','balance','wallet','transactions','bonuses','kyc','aml','rg','account','activity'] else field_names end);
      result := result || jsonb_build_object(item.key,cleaned);
    elsif item.key='changed' and jsonb_typeof(item.value)='object' then
      select coalesce(jsonb_agg(k),'[]') into cleaned from jsonb_object_keys(item.value) k where k=any(field_names);
      result := result || jsonb_build_object('changed_fields',cleaned);
    end if;
  end loop;
  return result;
end $$;

create function minimise_audit_content() returns trigger language plpgsql
set search_path=pg_catalog,public as $$
declare owner_id uuid; original_owner uuid;
begin
  new.metadata := audit_metadata_facts(new.action,new.metadata);
  -- Keep attribution after retention removes a ticket/note. Scope every lookup.
  if new.target_type='ticket' then
    select customer_id,pre_merge_customer_id into owner_id,original_owner from tickets
      where id=new.target_id and workspace_id=new.workspace_id;
  elsif new.target_type='customer' then
    select id into owner_id from customers where id=new.target_id and workspace_id=new.workspace_id;
  elsif new.target_type='customer_note' then
    select customer_id,merged_from_customer_id into owner_id,original_owner from customer_notes
      where id=new.target_id and workspace_id=new.workspace_id;
  elsif new.target_type='ticket_message' then
    select t.customer_id,t.pre_merge_customer_id into owner_id,original_owner from ticket_messages m
      join tickets t on t.id=m.ticket_id and t.workspace_id=m.workspace_id
      where m.id=new.target_id and m.workspace_id=new.workspace_id;
  end if;
  if owner_id is not null then new.metadata := new.metadata || jsonb_build_object('customer_id',owner_id); end if;
  if original_owner is not null then new.metadata := new.metadata || jsonb_build_object('original_customer_id',original_owner); end if;
  new.actor_ip := null; new.actor_ua := null;
  return new;
end $$;
-- PostgreSQL runs same-event triggers alphabetically: sanitise before chain_ins.
create trigger audit_events_00_minimise before insert on audit_events
  for each row execute function minimise_audit_content();

create function guard_activity_content() returns trigger language plpgsql
set search_path=pg_catalog,public as $$
declare erased timestamptz;
begin
  if tg_op='UPDATE' and new.details='[erased]' and new.author_label='[erased]'
    and (to_jsonb(new)-array['details','author_label'])=(to_jsonb(old)-array['details','author_label']) then return new; end if;
  if new.entity_type='ticket' then
    -- Lock against retention deleting the parent, then follow the S2 NOWAIT
    -- customer-lock discipline to avoid reversing the erasure lock order.
    perform 1 from tickets where id=new.entity_id and workspace_id=new.workspace_id for key share;
    if not found then raise exception 'Ticket is unavailable' using errcode='23514',constraint='customer_erased'; end if;
    perform assert_ticket_content(new.workspace_id,array[new.entity_id]);
  elsif new.entity_type='customer' then
    select erased_at into erased from customers where id=new.entity_id and workspace_id=new.workspace_id for share nowait;
    if not found or erased is not null then
      raise exception 'Customer is unavailable' using errcode='23514',constraint='customer_erased';
    end if;
  end if;
  return new;
end $$;
create trigger events_content_guard before insert or update on events
  for each row execute function guard_activity_content();

create function erase_customer_activity() returns trigger language plpgsql
set search_path=pg_catalog,public as $$ begin
  if new.erased_at is not null then
    update events set details='[erased]',author_label='[erased]' where workspace_id=new.workspace_id
      and ((entity_type='customer' and entity_id=new.id) or (entity_type='ticket' and entity_id in
        (select id from tickets where workspace_id=new.workspace_id and customer_id=new.id)));
  end if;
  return new;
end $$;
create trigger customer_activity_erasure after update of erased_at on customers
  for each row execute function erase_customer_activity();

create function delete_parent_activity() returns trigger language plpgsql
set search_path=pg_catalog,public as $$ begin
  delete from events where workspace_id=old.workspace_id and entity_id=old.id
    and entity_type=case when tg_table_name='tickets' then 'ticket' else 'customer' end;
  return old;
end $$;
create trigger ticket_activity_cleanup after delete on tickets for each row execute function delete_parent_activity();
create trigger customer_activity_cleanup after delete on customers for each row execute function delete_parent_activity();

create function minimise_erasure_reason() returns trigger language plpgsql
set search_path=pg_catalog,public as $$ begin
  if new.reason is not null and new.reason not in ('subject_request','retention_expired','consent_withdrawn','other') then
    new.reason := 'other';
  end if;
  return new;
end $$;
create trigger gdpr_erasure_reason_guard before insert or update of reason on gdpr_erasures
  for each row execute function minimise_erasure_reason();
