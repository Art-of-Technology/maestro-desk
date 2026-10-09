-- The runtime may request verification, but must not forge checkpoints itself.
create function audit_events_verify_checked(reset_first boolean default false)
returns table(workspace_id uuid,ok boolean,first_bad_seq bigint,first_bad_id uuid)
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  -- Consistent lock order with maintenance. Ordinary audit inserts remain free.
  lock table public.audit_events in access share mode;
  lock table public.audit_verify_checkpoints in share row exclusive mode;
  if reset_first then delete from public.audit_verify_checkpoints; end if;
  return query select * from public.audit_events_verify_incremental();
end $$;
revoke all on function audit_events_verify_checked(boolean) from public;
-- Runtime access is granted separately by the explicit operator command.
