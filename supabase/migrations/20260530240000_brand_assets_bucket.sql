-- First-party hosting for workspace logos. Public bucket so the URLs
-- we paste into outbound emails resolve without signed URLs (logos
-- are intentionally public anyway — they're embedded in customer-
-- facing email senders + the portal).
--
-- Path convention enforced by the API (api/src/routes/workspace.ts):
--   {workspace_id}/logo-{timestamp}.{ext}
-- Old files are deleted on successful re-upload; if an admin keeps
-- uploading and the cleanup ever fails, orphans accumulate but stay
-- harmless (small + isolated to the workspace prefix).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'brand-assets',
  'brand-assets',
  true,
  2097152,                                                     -- 2 MB
  array['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']
)
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Read policy is permissive because the bucket is public — anyone
-- with the URL gets the bytes. The explicit SELECT policy here just
-- documents intent; without it the default behaviour is the same
-- (Supabase's public buckets short-circuit to no-auth read).

drop policy if exists "brand_assets_public_read" on storage.objects;
create policy "brand_assets_public_read" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'brand-assets');

-- No INSERT / UPDATE / DELETE policies — the API uploads via
-- service-role (which bypasses RLS), and we deliberately don't want
-- authenticated end-users PUTting files directly. If we ever expose
-- direct-upload to the SPA we'll add a per-workspace-admin write
-- policy keyed off the first path segment.
