-- Adopt the existing Space Casino workspace instead of provisioning a second
-- workspace on Maestro sign-in. The brand was verified through Maestro's
-- organization brand list and an exact customer-account lookup.
do $$
declare
  target_workspace constant uuid := '69a587ed-4487-427a-a06c-610d98d83149';
  target_brand constant uuid := '58d5016a-91bb-49e6-a9be-b3f36f08afde';
  current_workspace workspaces%rowtype;
begin
  select * into current_workspace from workspaces
    where id = target_workspace and deleted_at is null for update;
  -- Other environments do not necessarily contain this production workspace.
  if not found then return; end if;
  if current_workspace.name <> 'Space Casino' or current_workspace.slug <> 'spacecasino' then
    raise exception 'Space Casino workspace identity does not match; connection unchanged';
  end if;
  if current_workspace.maestro_brand_id = target_brand then return; end if;
  if current_workspace.maestro_brand_id is not null then
    raise exception 'Space Casino workspace already has a different Maestro brand';
  end if;
  if exists (select 1 from workspaces where maestro_brand_id = target_brand and deleted_at is null and id <> target_workspace) then
    raise exception 'Space Casino Maestro brand already belongs to another workspace';
  end if;

  update workspaces set maestro_brand_id = target_brand where id = target_workspace;
  -- audit_events_chain_ins generates the tamper-evident hash in the database.
  insert into audit_events (workspace_id, actor_user_id, action, target_type, target_id, metadata)
    values (target_workspace, null, 'brand.maestro_connected', 'workspace', target_workspace,
      jsonb_build_object('old_maestro_brand_id', null, 'maestro_brand_id', target_brand,
        'reason', 'Approved Space Casino account connection repair',
        'migration', '20260908092000_connect_space_casino_maestro.sql'));
end $$;
