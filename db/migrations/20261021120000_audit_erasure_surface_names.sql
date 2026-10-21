-- Prospective field names only. Do not rewrite historical audit metadata or hashes.
create or replace function audit_metadata_facts(action_name text, data jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog,public as $$
declare result jsonb := '{}'; item record; value text; field text; cleaned jsonb;
  uuid_pattern constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  field_names constant text[] := array['first_name','last_name','username','email','mobile','backoffice_url',
    'kyc_status','jurisdiction','preferred_language','maestro_user_id','maestro_member_id','vip_tier','consent','since','is_spam',
    'name','address','type','active','role_id','suspended_at','deleted_at','retention_days',
    'ai_enabled','auto_reply_min_confidence','auto_reply_categories','default_priority','default_category',
    'contacts','tickets.last_inbound_email','tickets.closure_note','tickets.status_reason_label','note_revisions','ticket_messages.email_metadata','ticket_messages.sent_email',
    'message_drafts','custom_field_values','webhook_deliveries','tickets.ai_summary','tickets.ai_draft_reply',
    'ticket_tags','ticket_ai_tags','time_entries.note','merged_message_copies','forwarded_message_copies','reply_internal_reviews','events'];
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
