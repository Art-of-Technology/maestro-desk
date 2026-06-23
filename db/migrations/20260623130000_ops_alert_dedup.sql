-- De-duplication backing for the live ops-alert system (lib/alert.ts).
--
-- The API runs as ephemeral, multi-instance serverless functions on Vercel, so
-- an in-process "have I already alerted on this?" cache resets on every cold
-- start and isn't shared across instances — useless for suppressing a storm of
-- the same failure. Neon is the shared source of truth (and the stack forbids
-- Redis), so a tiny counter table with an atomic claim function is the fit —
-- mirroring rate_limit_hits / check_rate_limit.

-- One row per alert signature (e.g. "api-error:POST:/api/v1/tickets:TypeError").
-- Updated in place, so the table is bounded by the number of distinct alert
-- kinds seen, and pruned by prune_ops_alerts() below.
create table ops_alert_dedup (
  signature   text        primary key,
  first_seen  timestamptz not null default now(),
  last_sent   timestamptz not null default now(),
  suppressed  int         not null default 0   -- collapsed since the last send
);

-- Atomic claim: should this alert be delivered now, or is it within the cooldown
-- of a recent identical one? Returns should_send plus, when we ARE sending after
-- a quiet-then-busy window, how many occurrences were suppressed in between (so
-- the message can say "+N more suppressed"). The single upsert runs under a row
-- lock, so concurrent claims for the same signature serialise and exactly one
-- wins the send.
create function claim_ops_alert(p_signature text, p_cooldown_seconds int)
returns table (should_send boolean, suppressed_since int)
language plpgsql
as $$
declare
  v_now            timestamptz := now();
  v_prev           int;
  v_existed        boolean;
begin
  select suppressed into v_prev from ops_alert_dedup where signature = p_signature;
  v_existed := found;

  insert into ops_alert_dedup (signature, first_seen, last_sent, suppressed)
  values (p_signature, v_now, v_now, 0)
  on conflict (signature) do update set
    last_sent  = case when ops_alert_dedup.last_sent < v_now - make_interval(secs => p_cooldown_seconds)
                      then v_now else ops_alert_dedup.last_sent end,
    suppressed = case when ops_alert_dedup.last_sent < v_now - make_interval(secs => p_cooldown_seconds)
                      then 0 else ops_alert_dedup.suppressed + 1 end
  returning (ops_alert_dedup.last_sent = v_now) into should_send;

  -- prev count only matters when we're firing after having suppressed some.
  suppressed_since := case when should_send and v_existed then coalesce(v_prev, 0) else 0 end;
  return next;
end;
$$;

-- Housekeeping: drop signatures untouched for a month. Called from the daily
-- webhook-retry cron (alongside prune_rate_limits) so the table stays small.
create function prune_ops_alerts()
returns void
language sql
as $$
  delete from ops_alert_dedup where last_sent < now() - interval '30 days';
$$;
