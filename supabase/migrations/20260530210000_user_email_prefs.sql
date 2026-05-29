-- Per-user opt-out for mention notification emails. Defaults to true
-- so existing users keep receiving the emails introduced in PR #226
-- without further action.
--
-- Lives on the users table rather than a separate user_preferences
-- table for v1 — single flag, simple read path. If we add more
-- email preferences (digest, SLA breach alerts, etc.) and the column
-- count starts climbing, the natural next step is a jsonb
-- email_preferences column or a dedicated table.

alter table public.users
  add column mention_email_enabled boolean not null default true;
