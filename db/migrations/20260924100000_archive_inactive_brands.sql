-- Owner-approved archive: retain all records and integration configuration.
-- Deliberately targets these four existing brands, not every non-Space workspace.
-- Restoration is an explicit operation: clear deleted_at, leaving suspension in place.
do $$
declare
  brand record;
  expected record;
begin
  for expected in select * from (values
    ('oh-my-casino-51515fe7', 'Oh My Casino'),
    ('xtreme-93311046', 'Xtreme'),
    ('casinovi-7b4dc7bc', 'Casinovi'),
    ('maestro-desk', 'Maestro-Desk')
  ) as targets(slug, name)
  loop
    select * into brand from workspaces where slug = expected.slug for update;
    if not found or brand.deleted_at is not null then continue; end if;
    if brand.name <> expected.name or brand.is_unrouted_bucket or brand.suspended_at is null then
      raise exception 'Archive precondition failed for %', expected.slug;
    end if;
    if not exists(select 1 from workspaces where slug='spacecasino' and name='Space Casino'
      and deleted_at is null and suspended_at is null and not is_unrouted_bucket) then
      raise exception 'Active Space Casino workspace must exist before archiving';
    end if;
    insert into audit_events(workspace_id, actor_user_id, action, target_type, target_id, metadata)
    values (brand.id, null, 'brand.archived', 'workspace', brand.id,
      jsonb_build_object('reason', 'Owner-approved archive of non-Space Casino brands',
        'migration', '20260924100000_archive_inactive_brands',
        'slug', brand.slug, 'previous_suspended_at', brand.suspended_at,
        'previous_deleted_at', brand.deleted_at,
        'tickets_preserved', (select count(*) from tickets where workspace_id=brand.id),
        'customers_preserved', (select count(*) from customers where workspace_id=brand.id),
        'members_preserved', (select count(*) from workspace_members where workspace_id=brand.id),
        'domains_preserved', (select count(*) from workspace_email_domains where workspace_id=brand.id)));
    update workspaces set deleted_at=now(), updated_at=now() where id=brand.id;
    raise notice 'Archived brand: % (historical records retained)', brand.slug;
  end loop;
end $$;
