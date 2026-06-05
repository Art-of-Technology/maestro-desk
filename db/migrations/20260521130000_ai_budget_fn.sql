-- AI budget enforcement.
--
-- `deduct_ai_credits` is an atomic decrement via a single UPDATE statement —
-- safer than read-modify-write from app code, where two concurrent triages
-- could both see the balance, both decide they're under budget, and both
-- deduct (last-write-wins, leaving the workspace overspent).
--
-- The function deliberately does NOT refuse to decrement below zero — the
-- caller is responsible for the pre-flight check. If the API forgets to
-- check (or two concurrent calls slip past the check), the workspace can
-- go briefly negative. Next call's pre-check then refuses, and the deficit
-- is recovered on top-up.
--
-- security definer + grant execute to service_role: the API never lets
-- authenticated users call this directly. RLS would deny the underlying
-- UPDATE anyway, but security definer + restricted grant is belt + braces.

create or replace function public.deduct_ai_credits(
  p_workspace_id uuid,
  p_amount_micro bigint
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  new_balance bigint;
begin
  update workspaces
    set ai_credits_micro = ai_credits_micro - p_amount_micro,
        updated_at = now()
    where id = p_workspace_id
    returning ai_credits_micro into new_balance;
  if new_balance is null then
    raise exception 'workspace % not found', p_workspace_id;
  end if;
  return new_balance;
end;
$$;


-- Give the demo workspace $5 of starting credit so triage testing isn't
-- immediately blocked. $5 = 5,000,000 micro-USD ~= 150-250 triage calls
-- at current Sonnet 4.6 prices with prompt caching.
update workspaces
  set ai_credits_micro = 5000000
  where id = '00000000-0000-0000-0000-000000000001'
    and ai_credits_micro = 0;
