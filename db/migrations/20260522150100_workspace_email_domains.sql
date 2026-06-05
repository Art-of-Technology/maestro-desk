-- Per-workspace inbound email domains for BYO-domain white-label routing.
--
-- The Postmark inbound webhook (PR D) parses the To: address of each
-- incoming email, extracts the domain part, and looks up the row here to
-- find the destination workspace. Unmatched domains fall through to the
-- system unrouted bucket (see 20260522150000_workspace_branding.sql).
--
-- Many-to-one: a workspace can have multiple verified domains (acme.com +
-- acme-eu.com), and a single mailbox like support@A.com + help@A.com both
-- route to the same workspace because both share the domain.
--
-- One domain belongs to AT MOST one workspace — enforced by the unique
-- constraint on domain. We use citext so 'Acme.COM' and 'acme.com' compare
-- equal at lookup time without needing lower() everywhere.
--
-- verified_at: NULL until Postmark confirms DNS / DKIM / Return-Path setup.
-- The Postmark "Domains" API (separate from Sender Signatures) handles this
-- side of things. Inbound routing can technically work before verification
-- (MX records are independent), but outbound DKIM signing requires it.
--
-- postmark_domain_id: Postmark's internal id for the domain object. Stored
-- so PR E can hit the Postmark API to refresh verification status, rotate
-- DKIM keys, or delete the domain when a brand offboards.

create table workspace_email_domains (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  domain              citext not null unique,
  verified_at         timestamptz,
  postmark_domain_id  text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);

create trigger set_updated_at before update on workspace_email_domains
  for each row execute function trigger_set_updated_at();

-- Reverse-lookup: "all domains for this workspace" (used by the god panel
-- + the brand-owner settings view). Partial index excludes soft-deleted rows.
create index workspace_email_domains_workspace_id_idx
  on workspace_email_domains (workspace_id)
  where deleted_at is null;

-- Forward-lookup: domain → workspace. The unique constraint above creates an
-- index automatically, but it includes soft-deleted rows. A partial index
-- gives the inbound webhook an exact-match index it can scan without
-- worrying about tombstones. (Soft-deleted rows must NOT reappear — when a
-- brand offboards, we soft-delete + free up the domain for re-use.)
--
-- Wait — if we ever want to reuse a domain after soft-delete, the unique
-- constraint blocks it. Two-phase fix: drop unique, add partial unique.
alter table workspace_email_domains drop constraint workspace_email_domains_domain_key;
create unique index workspace_email_domains_domain_active_uq
  on workspace_email_domains (domain)
  where deleted_at is null;
