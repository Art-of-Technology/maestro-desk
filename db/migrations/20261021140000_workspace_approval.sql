create table workspace_registration_settings (
  id boolean primary key default true check (id),
  automatic boolean not null default false,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
insert into workspace_registration_settings(id) values(true);

create table workspace_requests (
  maestro_brand_id uuid primary key,
  brand_name text not null,
  brand_slug text,
  organization_id uuid,
  organization_name text not null,
  requester_id uuid not null references users(id),
  requested_at timestamptz not null default now(),
  approved_by uuid references users(id),
  approved_at timestamptz,
  workspace_id uuid references workspaces(id),
  check ((approved_at is null and approved_by is null and workspace_id is null)
      or (approved_at is not null and approved_by is not null and workspace_id is not null))
);

-- Keep the archived mapping so Maestro login cannot recreate this workspace.
do $$
declare target workspaces%rowtype;
begin
  select * into target from workspaces
    where slug='testnewpagebuilderbrand-237301e6' and deleted_at is null;
  if found then
    if target.name <> 'TestNewPageBuilderBrand' or target.is_unrouted_bucket
      or not exists(select 1 from workspaces where slug='spacecasino' and name='Space Casino' and deleted_at is null and suspended_at is null)
      or not exists(select 1 from workspaces where slug='test-casino' and name='Test Casino' and deleted_at is null and suspended_at is null) then
      raise exception 'Workspace archive identity or retained-brand checks failed';
    end if;
    insert into audit_events(workspace_id,actor_user_id,action,target_type,target_id,metadata)
    values(target.id,null,'brand.archived','workspace',target.id,
      jsonb_build_object('reason','Owner-approved archive of extra Maestro workspace',
        'migration','20261021140000_workspace_approval','slug',target.slug));
    update workspaces set deleted_at=now(),updated_at=now() where id=target.id;
  end if;
end $$;
