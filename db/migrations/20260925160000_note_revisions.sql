create table note_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  ticket_message_id uuid references ticket_messages(id) on delete cascade,
  customer_note_id uuid references customer_notes(id) on delete cascade,
  editor_user_id uuid references users(id) on delete set null,
  editor_label text not null,
  before_text text not null,
  after_text text not null,
  before_html text,
  created_at timestamptz not null default clock_timestamp(),
  check (num_nonnulls(ticket_message_id, customer_note_id) = 1)
);
create index on note_revisions(workspace_id, ticket_message_id, created_at desc);
create index on note_revisions(workspace_id, customer_note_id, created_at desc);
-- Content is erasable; the permanent audit event links the revision without copying its text.
