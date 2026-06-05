-- Follow-up to 20260601140000_bump_ticket_updated_at_on_children.sql
-- responding to Octopus review feedback on PR #237.
--
-- Two changes:
--
-- 1. Guard the bump UPDATE on `deleted_at is null`. Soft-deleted parents
--    shouldn't get spurious updated_at bumps from late child mutations
--    (would re-surface them on activity-sorted lists). For hard-delete
--    cascades from tickets → child tables, the parent row is already
--    gone, so the predicate matches 0 rows — making the trigger
--    fan-out during a cascade a cheap no-op instead of a wasted UPDATE.
--
-- 2. Re-create the four triggers with `create or replace trigger` so the
--    underlying schema is idempotent against a re-apply. The originals
--    in 20260601140000 used plain `create trigger`, which would error
--    on a second pass (a fresh dev env applying the merged set, a
--    Docker validation against the released file, etc.).
--
-- Live Supabase already has the originals from 20260601140000; this
-- migration replaces both the function body and the trigger
-- definitions in place via OR REPLACE — no DROP needed.

create or replace function public.bump_ticket_updated_at()
returns trigger
language plpgsql
as $$
begin
  update public.tickets
  set updated_at = now()
  where id = coalesce(new.ticket_id, old.ticket_id)
    and deleted_at is null;
  return coalesce(new, old);
end;
$$;

create or replace trigger bump_ticket_on_message
  after insert or update or delete on ticket_messages
  for each row execute function public.bump_ticket_updated_at();

create or replace trigger bump_ticket_on_tag
  after insert or delete on ticket_tags
  for each row execute function public.bump_ticket_updated_at();

create or replace trigger bump_ticket_on_ai_tag
  after insert or update or delete on ticket_ai_tags
  for each row execute function public.bump_ticket_updated_at();

create or replace trigger bump_ticket_on_time_entry
  after insert or update or delete on time_entries
  for each row execute function public.bump_ticket_updated_at();
