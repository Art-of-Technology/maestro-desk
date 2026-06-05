-- Workspace branding + system "unrouted" bucket.
--
-- New columns on workspaces:
--   logo_url                       — public URL of the brand's logo (Cloudflare R2 or similar).
--                                    NULL until the brand uploads one. Sender + portal use it.
--   primary_color                  — brand accent hex like '#0a84ff'. NULL falls back to the
--                                    Maestro default in the SPA theme. Free-form text rather
--                                    than a check constraint so designers can paste any value
--                                    Postmark / the SPA accept.
--   support_email_display_name     — the "From" name used on outbound mail (e.g.,
--                                    "Acme Casino Support"). NULL means the API falls back to
--                                    `workspaces.name`. Stored separately so brands can use a
--                                    different external face than their internal workspace name.
--   suspended_at                   — set by a platform admin to deactivate a brand without
--                                    deleting it. The API gates inbound webhook routing,
--                                    outbound sends, and auth on this. Suspension is reversible;
--                                    a deletion is `workspaces.deleted_at` (already exists).
--   is_unrouted_bucket             — flag marking the system workspace that catches inbound
--                                    mail whose To: domain doesn't match any
--                                    workspace_email_domains row. Exactly one workspace can
--                                    carry this flag (partial unique index below). Brand-
--                                    owned workspaces always have this = false.
--
-- Why a flag (not a magic UUID) for the unrouted bucket:
--   Lookup is `select id from workspaces where is_unrouted_bucket = true` — the partial
--   index makes it index-only. Changing the bucket workspace (e.g., if the row gets corrupted)
--   is a single UPDATE rather than hunting a hardcoded UUID in the API code.

alter table workspaces
  add column if not exists logo_url                   text,
  add column if not exists primary_color              text,
  add column if not exists support_email_display_name text,
  add column if not exists suspended_at               timestamptz,
  add column if not exists is_unrouted_bucket         boolean not null default false;

-- At most one workspace can be the unrouted bucket at a time. Partial index
-- (where is_unrouted_bucket = true) keeps the false rows out of the index
-- so it stays a 1-row, O(1) lookup.
create unique index if not exists workspaces_one_unrouted_bucket
  on workspaces (is_unrouted_bucket)
  where is_unrouted_bucket = true;

-- Seed the system unrouted workspace. Idempotent via ON CONFLICT — re-running
-- the migration won't duplicate or overwrite an existing row.
--
-- UUID 00000000-0000-0000-0000-0000000000ff is chosen to be recognisable in
-- logs as the "system / catch-all" workspace alongside the demo's
-- 00000000-0000-0000-0000-000000000001.
--
-- The slug starts with `__` to keep it out of the brand-slug namespace; the
-- god UI will hide rows where is_unrouted_bucket = true from the normal brand
-- list (or label them as system rows). RLS makes them invisible to non-
-- platform-admin users already.
insert into workspaces (id, slug, name, plan, is_unrouted_bucket)
values (
  '00000000-0000-0000-0000-0000000000ff',
  '__unrouted',
  'Unrouted mail (system)',
  'system',
  true
)
on conflict (id) do nothing;
