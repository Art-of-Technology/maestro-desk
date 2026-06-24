-- Email branding: brand header/footer templates + per-sender signatures.
--
-- Outbound product emails (auto-reply, CSAT, @mention notifications,
-- magic-link sign-in, password reset) are wrapped with a brand header +
-- footer and — when an agent authored the email — that agent's signature.
-- The logo is reused from workspaces.logo_url (no separate upload); a
-- template only toggles whether to show it. Emails are sent as HTML with a
-- plain-text fallback, so each block stores both an *_html and an *_text form.
--
-- "Default" selection mirrors the workspaces_one_unrouted_bucket pattern: a
-- partial unique index enforces at most one default per scope among live rows.

-- ─── Brand header/footer templates (workspace-scoped, admin-managed) ───────
create table if not exists email_brand_templates (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,
  header_html   text,
  header_text   text,
  footer_html   text,
  footer_text   text,
  -- When true (and the workspace has a logo_url), the header renders the logo.
  show_logo     boolean not null default true,
  is_default    boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create index if not exists email_brand_templates_ws
  on email_brand_templates (workspace_id)
  where deleted_at is null;

-- At most one default template per workspace, among live rows.
create unique index if not exists email_brand_templates_one_default
  on email_brand_templates (workspace_id)
  where is_default = true and deleted_at is null;

-- ─── Per-sender signatures (scoped to a user within a workspace) ───────────
create table if not exists email_signatures (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  name          text not null,
  body_html     text,
  body_text     text,
  is_default    boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create index if not exists email_signatures_ws_user
  on email_signatures (workspace_id, user_id)
  where deleted_at is null;

-- At most one default signature per (workspace, user), among live rows.
create unique index if not exists email_signatures_one_default
  on email_signatures (workspace_id, user_id)
  where is_default = true and deleted_at is null;
