-- Keep one append-only policy for audit rows and repair receipts, but identify
-- the actual table in operator diagnostics. Enforcement is unchanged.
create or replace function audit_events_immutable() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
  if tg_op='UPDATE' then
    raise exception '% is append-only: UPDATE is not permitted (id=%)',tg_table_name,old.id
      using errcode='check_violation';
  end if;
  if exists(select 1 from workspaces where id=old.workspace_id) then
    raise exception '% is append-only: direct DELETE is not permitted (id=%)',tg_table_name,old.id
      using errcode='check_violation';
  end if;
  return old;
end $$;
