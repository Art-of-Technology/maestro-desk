-- Owner-approved archive; retain records and mapping to prevent reprovisioning.
do $$
declare target workspaces%rowtype;
begin
  select * into target from workspaces
    where slug='studio-acceptance-20261008-d4628444' and deleted_at is null;
  if found then
    if target.name <> 'Studio Acceptance 20261008' or target.is_unrouted_bucket
      or not exists(select 1 from workspaces where slug='spacecasino' and name='Space Casino' and deleted_at is null and suspended_at is null)
      or not exists(select 1 from workspaces where slug='test-casino' and name='Test Casino' and deleted_at is null and suspended_at is null) then
      raise exception 'Workspace archive identity or retained-brand checks failed';
    end if;
    insert into audit_events(workspace_id,actor_user_id,action,target_type,target_id,metadata)
    values(target.id,null,'brand.archived','workspace',target.id,
      jsonb_build_object('reason','Owner-approved archive of extra Maestro workspace',
        'migration','20261021160000_archive_studio_acceptance','slug',target.slug));
    update workspaces set deleted_at=now(),updated_at=now() where id=target.id;
  end if;
end $$;
