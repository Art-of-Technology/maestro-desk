-- Pinning is a personal preference on an existing saved filter.
alter table kb_saved_filters add column is_pinned boolean not null default false;
