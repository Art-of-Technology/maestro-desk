-- Expression indexes cover existing history immediately and track edits without
-- a separate copy of customer content or a backfill worker.
create index reply_customer_text_search on ticket_messages
  using gin (to_tsvector('simple', left(body, 8000)))
  where role = 'customer' and deleted_at is null and merged_from_id is null;

create index reply_ticket_subject_search on tickets
  using gin (to_tsvector('simple', left(subject, 1000)))
  where deleted_at is null and merged_into_id is null and status_key in ('resolved', 'closed');
