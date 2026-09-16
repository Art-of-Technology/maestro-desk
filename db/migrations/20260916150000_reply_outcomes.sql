alter table ai_reply_suggestions
  add column reply_language text check (length(reply_language)<=100),
  add column query_type text,
  add column rejected_at timestamptz,
  add column sent_change_ratio real check (sent_change_ratio between 0 and 1);
