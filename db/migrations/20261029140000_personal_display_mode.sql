alter table users add column display_mode text not null default 'light'
  check (display_mode in ('light', 'dark', 'system'));
