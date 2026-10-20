alter table ticket_statuses
  add column base_key text,
  add column send_survey boolean not null default false,
  add column is_active boolean not null default true;
update ticket_statuses set base_key = case
  when key in ('open','pending','escalated','gdpr','resolved','closed') then key
  when is_terminal then 'resolved' else 'open' end,
  send_survey = (key = 'resolved');
alter table ticket_statuses alter column base_key set not null;
alter table ticket_statuses add constraint ticket_status_category check (
  base_key in ('open','pending','escalated','gdpr','resolved','closed')
  and (not send_survey or base_key = 'resolved')
  and (key not in ('open','pending','escalated','gdpr','resolved','closed') or (base_key = key and is_active))
);

create function default_ticket_status_category() returns trigger language plpgsql as $$
begin
  if new.base_key is null then
    new.base_key := case when new.key in ('open','pending','escalated','gdpr','resolved','closed') then new.key
      when new.is_terminal then 'resolved' else 'open' end;
    new.send_survey := new.key = 'resolved';
  end if;
  new.is_terminal := new.base_key in ('resolved','closed');
  return new;
end;
$$;
create trigger ticket_status_category_defaults before insert or update on ticket_statuses
for each row execute function default_ticket_status_category();

alter table tickets
  add column status_option_key text,
  add column status_survey_enabled boolean not null default false,
  add column status_option_before_merge text,
  add column survey_enabled_before_merge boolean;
update tickets t set status_option_key = t.status_key, status_survey_enabled = s.send_survey,
  status_key = s.base_key from ticket_statuses s where s.workspace_id=t.workspace_id and s.key=t.status_key;
alter table tickets alter column status_option_key set not null;
alter table tickets add constraint tickets_status_option_fk foreign key (workspace_id, status_option_key)
  references ticket_statuses(workspace_id, key);

-- Keep legacy writers (inbound mail, reopen, merge and integrations) consistent with agent selections.
create function apply_ticket_status_option() returns trigger language plpgsql as $$
declare choice ticket_statuses%rowtype; selecting boolean; restoring boolean := false;
begin
  if tg_op = 'INSERT' then
    new.status_option_key := coalesce(new.status_option_key, new.status_key);
    selecting := true;
  else
    if old.merged_into_id is null and new.merged_into_id is not null then
      new.status_option_before_merge := old.status_option_key;
      new.survey_enabled_before_merge := old.status_survey_enabled;
    elsif old.merged_into_id is not null and new.merged_into_id is null and old.status_option_before_merge is not null then
      new.status_option_key := old.status_option_before_merge;
      restoring := true;
    end if;
    if not restoring and new.status_key is distinct from old.status_key and new.status_option_key = old.status_option_key then
      new.status_option_key := new.status_key;
    end if;
    selecting := new.status_option_key is distinct from old.status_option_key or new.status_key is distinct from old.status_key;
    if selecting and old.csat_send_claim is not null and old.csat_send_started_at >= now() - interval '10 minutes' then
      raise exception 'A survey is being sent. Try changing status once it finishes.'
        using errcode = '23514', constraint = 'ticket_status_survey_in_progress';
    end if;
  end if;
  if selecting then
    select * into choice from ticket_statuses where workspace_id = new.workspace_id and key = new.status_option_key for share;
    if not found or (not choice.is_active and not restoring) then
      raise exception 'This ticket status is unavailable. Reload the status options.'
        using errcode = '23514', constraint = 'ticket_status_unavailable';
    end if;
    new.status_key := choice.base_key;
    new.status_survey_enabled := case when restoring then old.survey_enabled_before_merge else choice.send_survey end;
    if tg_op = 'UPDATE' then
      if new.status_key = 'resolved' and old.status_key <> 'resolved' then new.resolved_at := now();
      elsif new.status_key = 'resolved' then new.resolved_at := old.resolved_at;
      elsif new.status_key <> 'resolved' then new.resolved_at := null;
      end if;
    elsif new.status_key = 'resolved' then new.resolved_at := coalesce(new.resolved_at, now());
    end if;
  end if;
  return new;
end;
$$;
create trigger ticket_status_option before insert or update of status_key, status_option_key, merged_into_id on tickets
for each row execute function apply_ticket_status_option();

-- Preserve status identifiers and policy facts without putting names into permanent audit history.
-- Prospective controls only. Existing audit hashes and metadata are untouched.
-- Unknown metadata is discarded rather than made permanent by a new writer.
create or replace function audit_metadata_facts(action_name text, data jsonb) returns jsonb
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
    elsif action_name=any(array['ticket.status.changed','ticket_status.created','ticket_status.updated'])
      and item.key=any(array['key','before_option','after_option']) and jsonb_typeof(item.value)='string'
      and (value=any(array['open','pending','escalated','gdpr','resolved','closed']) or value ~ ('^custom-' || substring(uuid_pattern from 2))) then
      result := result || jsonb_build_object(item.key,value);
    elsif action_name=any(array['ticket_status.created','ticket_status.updated'])
      and item.key=any(array['send_survey','is_active','label_changed']) and jsonb_typeof(item.value)='boolean' then
      result := result || jsonb_build_object(item.key,item.value);
    elsif action_name=any(array['ticket_status.created','ticket_status.updated']) and item.key='base_key'
      and value=any(array['open','pending','escalated','gdpr','resolved','closed']) then
      result := result || jsonb_build_object(item.key,value);
    elsif action_name='ticket_status.updated' and item.key=any(array['before','after']) and jsonb_typeof(item.value)='object' then
      cleaned := '{}';
      foreach field in array array['send_survey','is_active'] loop
        if jsonb_typeof(item.value->field)='boolean' then cleaned := cleaned || jsonb_build_object(field,item.value->field); end if;
      end loop;
      result := result || jsonb_build_object(item.key,cleaned);
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

