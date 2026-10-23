-- NULL preserves existing access; an explicit object is a saved permission set.
alter table roles add column permissions jsonb;
alter table roles add column permissions_version integer not null default 0;
alter table roles add constraint role_permissions_object check (permissions is null or jsonb_typeof(permissions) = 'object');
