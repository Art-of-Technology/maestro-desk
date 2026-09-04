-- Rich email bodies + real attachments (foundation).
--
-- ticket_messages.body_html: the SANITISED HTML of an email (inbound or an
-- agent's rich reply). Nullable — plain-text messages, notes and legacy rows
-- keep it null and the UI falls back to `body`. The raw inbound HTML still
-- lives on inbox_messages.body_html for re-sanitising later.
--
-- ticket_attachments gains what inline (cid:) images need:
--   content_id   the Content-ID the HTML references (we store OUR attachment
--                uuid there and rewrite the email's cid: to it on ingest)
--   is_inline    true when the file is referenced from body_html as an image
--   disposition  'inline' (magic-byte-verified raster image, may render in a
--                tab) or 'attachment' (everything else — always downloads)
--
-- The partial index backs the orphan sweep: uploads are created with
-- message_id null and claimed when the message is posted; unclaimed rows
-- older than a day are removed by the retention cron.
--
-- pending_object_deletions parks R2 object keys the retention purge could not
-- delete (storage outage) so the next cron retries them — the same self-heal
-- gdpr_erasures.pending_object_keys gives erasure.

alter table ticket_messages add column if not exists body_html text;

alter table ticket_attachments
  add column if not exists content_id  text,
  add column if not exists is_inline   boolean not null default false,
  add column if not exists disposition text not null default 'attachment';

create index if not exists ticket_attachments_message_idx on ticket_attachments (message_id);
create index if not exists ticket_attachments_unclaimed_idx
  on ticket_attachments (created_at) where message_id is null;

create table if not exists pending_object_deletions (
  storage_key text primary key,
  reason      text not null,
  created_at  timestamptz not null default now()
);
