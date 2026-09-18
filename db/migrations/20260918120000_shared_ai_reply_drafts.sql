alter table ai_reply_suggestions
  add column draft_body text check (length(draft_body) <= 2000000),
  add column draft_is_html boolean not null default false,
  add column draft_review jsonb,
  add column draft_updated_by_user_id uuid references users(id) on delete set null,
  add column draft_updated_at timestamptz,
  add column draft_version integer not null default 0 check (draft_version >= 0),
  add column used_by_user_id uuid references users(id) on delete set null;

update ai_reply_suggestions set draft_body=reply,draft_updated_by_user_id=user_id,draft_updated_at=created_at
where reply_context='reply' and sent_message_id is null;
