alter table ticket_messages add column email_metadata jsonb;
comment on column ticket_messages.email_metadata is 'Email envelope and send outcome; null for legacy/non-email messages. Never establishes customer identity.';
