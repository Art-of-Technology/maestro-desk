-- Draft references keep unsent uploads alive until removed or sent.
alter table message_drafts add column attachment_ids uuid[] not null default '{}';
create index message_drafts_attachment_ids_idx on message_drafts using gin(attachment_ids);
