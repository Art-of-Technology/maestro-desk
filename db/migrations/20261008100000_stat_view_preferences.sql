alter table user_preferences
  add column stat_views jsonb not null default '{}'::jsonb
  check (jsonb_typeof(stat_views) = 'object');
