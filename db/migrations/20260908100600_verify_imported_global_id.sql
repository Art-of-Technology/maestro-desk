-- Retain legacy member numbers without presenting them as verified Global IDs.
alter table customers add column if not exists maestro_global_id_verified boolean not null default false;

update customers c set maestro_global_id_verified = true
where c.id = 'f5f8d68e-e74b-4578-a912-bf27c15b121a'
  and c.workspace_id = '69a587ed-4487-427a-a06c-610d98d83149'
  and c.display_id = 'M25' and c.maestro_user_id = '50119'
  and c.maestro_member_id = '332f9967fcd142989ab5a2715c5cc802'
  and not c.maestro_global_id_verified
  and c.deleted_at is null and c.erased_at is null and c.merged_into_customer_id is null
  and exists (select 1 from workspaces w where w.id = c.workspace_id
    and w.deleted_at is null and w.maestro_brand_id = '58d5016a-91bb-49e6-a9be-b3f36f08afde');
