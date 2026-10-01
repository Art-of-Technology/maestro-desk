-- Empty rows retain their version so an older device cannot resurrect cleared text.
alter table message_drafts
  add column version integer not null default 0 check (version >= 0),
  add column recipients jsonb,
  add column review jsonb;
