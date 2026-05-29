-- Denormalised "latest customer message sentiment" on tickets, so
-- ticket-list filtering by sentiment is a column read rather than a
-- per-row join into ticket_messages.
--
-- Populated by sentiment.ts after a customer message scores. We also
-- track the message's created_at so concurrent scoring of out-of-order
-- arrivals doesn't overwrite the freshest signal with a stale one.

alter table tickets
  add column latest_customer_sentiment    text
    check (latest_customer_sentiment is null or latest_customer_sentiment in ('angry', 'frustrated', 'neutral', 'positive')),
  add column latest_customer_message_at   timestamptz;

create index tickets_latest_customer_sentiment_idx
  on tickets (workspace_id, latest_customer_sentiment)
  where latest_customer_sentiment is not null;
