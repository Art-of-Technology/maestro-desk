-- Preserve existing assignments. Recover the original inbox from recorded
-- inbound messages; each message keeps its own receiving-channel history.
update tickets t set channel_id = original.channel_id
from (
  select distinct on (i.workspace_id, i.converted_ticket_id)
    i.workspace_id, i.converted_ticket_id, i.channel_id
  from inbox_messages i join channels c on c.id=i.channel_id and c.workspace_id=i.workspace_id
  where i.converted_ticket_id is not null and c.type='email' and c.deleted_at is null
  order by i.workspace_id, i.converted_ticket_id, i.received_at, i.id
) original
where t.id=original.converted_ticket_id and t.workspace_id=original.workspace_id
  and t.channel_id is null and t.deleted_at is null;
