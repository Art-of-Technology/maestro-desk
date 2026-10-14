-- Keep the actual composed content separately from the agent's working reply.
alter table ticket_messages add column sent_email jsonb;
alter table ticket_messages add constraint sent_email_object
  check (sent_email is null or jsonb_typeof(sent_email) = 'object');

-- Covers ordinary erasure, merged copies and operator repairs that redact body.
create function guard_sent_email_content() returns trigger language plpgsql as $$
begin
  if new.body = '[erased]' then
    new.sent_email := null;
  elsif new.sent_email is not null then
    perform assert_ticket_content(new.workspace_id, array_remove(array[new.ticket_id,new.merged_from_id],null));
  end if;
  return new;
end $$;
create trigger ticket_sent_email_privacy before insert or update on ticket_messages
  for each row execute function guard_sent_email_content();

-- Rollback: drop trigger ticket_sent_email_privacy on ticket_messages;
-- drop function guard_sent_email_content(); alter table ticket_messages drop column sent_email;
