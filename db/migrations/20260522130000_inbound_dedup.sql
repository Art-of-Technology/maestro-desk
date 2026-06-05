-- Cleanup: soft-delete duplicates that accumulated before this dedup
-- existed (Postmark retries during today's PR #138 end-to-end test
-- created multiple tickets for the same RFC Message-ID). Keep the
-- earliest customer message per (workspace_id, external_message_id);
-- soft-delete the later ones AND the tickets they belonged to. No-op
-- on databases that never accumulated dupes.
with dup_ids as (
  select id as msg_id, ticket_id
  from (
    select id, ticket_id,
      row_number() over (
        partition by workspace_id, external_message_id
        order by created_at
      ) as rn
    from ticket_messages
    where role = 'customer'
      and external_message_id is not null
      and deleted_at is null
  ) r
  where rn > 1
),
deleted_msgs as (
  update ticket_messages set deleted_at = now()
  where id in (select msg_id from dup_ids)
  returning ticket_id
)
update tickets set deleted_at = now()
where id in (select ticket_id from deleted_msgs);

-- Inbound dedup against Postmark webhook retries.
--
-- Postmark retries an inbound webhook up to 10 times on any non-2xx response,
-- and the same payload (with the same RFC Message-ID) is sent each time.
-- Without dedup, every retry creates a fresh ticket — we saw two of these
-- today during PR #138's end-to-end test when an earlier crash caused
-- Postmark to retry an already-half-processed email.
--
-- The application performs a lookup before creating anything; this index is
-- defense-in-depth for the rare concurrent-retry case (two attempts in
-- flight before either has written its row). Partial because it only
-- applies where dedup makes sense:
--   - role = 'customer'           — agent/ai/note rows don't carry inbound IDs
--   - external_message_id is not  — senders that omit Message-ID can't be
--     null                          deduped at all
--   - deleted_at is null          — soft-deleted history shouldn't block

create unique index ticket_messages_workspace_customer_external_id_uq
  on ticket_messages (workspace_id, external_message_id)
  where role = 'customer'
    and external_message_id is not null
    and deleted_at is null;
