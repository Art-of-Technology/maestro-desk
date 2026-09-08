-- One-time import approved after inspecting the authenticated backoffice.
-- The gateway does not currently expose Unique Global ID or Member since.
-- Legacy columns: maestro_user_id = Member ID; maestro_member_id = Global ID.
do $$
declare
  target_workspace constant uuid := '69a587ed-4487-427a-a06c-610d98d83149';
  target_customer constant uuid := 'f5f8d68e-e74b-4578-a912-bf27c15b121a';
  changed_id uuid;
begin
  update customers c set
    maestro_member_id = coalesce(nullif(btrim(c.maestro_member_id), ''), '332f9967fcd142989ab5a2715c5cc802'),
    since = coalesce(c.since, date '2026-08-30'),
    backoffice_url = coalesce(nullif(btrim(c.backoffice_url), ''), 'https://bo.spacecasino.com/Member/Detail/50119')
  where c.id = target_customer and c.workspace_id = target_workspace
    and c.display_id = 'M25' and c.maestro_user_id = '50119'
    and c.deleted_at is null and c.erased_at is null and c.merged_into_customer_id is null
    and exists (select 1 from workspaces w where w.id = c.workspace_id
      and w.deleted_at is null and w.maestro_brand_id = '58d5016a-91bb-49e6-a9be-b3f36f08afde')
    and (nullif(btrim(c.maestro_member_id), '') is null or c.since is null
      or nullif(btrim(c.backoffice_url), '') is null)
  returning c.id into changed_id;

  if changed_id is not null then
    insert into audit_events(workspace_id, actor_user_id, action, target_type, target_id, metadata)
      values(target_workspace, null, 'customer.account_details_imported', 'customer', changed_id,
        jsonb_build_object('source', 'Space Casino backoffice', 'reason', 'Approved verified account import',
          'migration', '20260908100500_import_m25_account_details.sql'));
  end if;
end $$;
