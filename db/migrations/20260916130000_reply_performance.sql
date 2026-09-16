alter table ai_reply_suggestions
  add column reply_context text check (reply_context in ('reply','note')),
  add column generation_cost_micro bigint check (generation_cost_micro >= 0),
  add column shown_at timestamptz,
  add column sent_message_id uuid references ticket_messages(id) on delete set null,
  add column sent_changed boolean;
create index on ai_reply_suggestions(workspace_id,created_at,id);
create index on ai_reply_suggestions(sent_message_id) where sent_message_id is not null;
-- NULL context/cost on existing rows means instrumentation was unavailable.
