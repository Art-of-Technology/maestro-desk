alter table user_preferences
  add column template_favourites jsonb not null default '{}'::jsonb
  check (jsonb_typeof(template_favourites) = 'object');
