-- Postgres-backed rate limiting for the unauthenticated public portal.
--
-- Why Postgres and not in-memory: the API runs as ephemeral, multi-instance
-- serverless functions on Vercel, so an in-process counter resets on every cold
-- start and isn't shared across instances — useless for abuse protection. Neon
-- is the shared source of truth, and the stack forbids Redis, so a tiny counter
-- table with an atomic check function is the right fit.

-- One row per bucket (e.g. "tickets:1.2.3.4"); updated in place, not appended,
-- so the table size is bounded by distinct (endpoint, client) pairs seen.
create table rate_limit_hits (
  bucket            text        primary key,
  window_started_at timestamptz not null,
  hits              int         not null
);

-- Fixed-window limiter. Atomically bumps the bucket's counter (resetting the
-- window if it has expired) and reports whether the caller is within p_max for
-- the current window, plus seconds until the window resets (for Retry-After).
-- The single upsert runs under a row lock, so concurrent requests for the same
-- bucket serialise and the count is exact.
create function check_rate_limit(p_bucket text, p_max int, p_window_seconds int)
returns table (allowed boolean, retry_after int)
language plpgsql
as $$
declare
  v_now     timestamptz := now();
  v_expired_before timestamptz := v_now - make_interval(secs => p_window_seconds);
  v_started timestamptz;
  v_hits    int;
begin
  insert into rate_limit_hits (bucket, window_started_at, hits)
  values (p_bucket, v_now, 1)
  on conflict (bucket) do update set
    window_started_at = case when rate_limit_hits.window_started_at < v_expired_before
                             then v_now else rate_limit_hits.window_started_at end,
    hits              = case when rate_limit_hits.window_started_at < v_expired_before
                             then 1 else rate_limit_hits.hits + 1 end
  returning rate_limit_hits.window_started_at, rate_limit_hits.hits
    into v_started, v_hits;

  allowed     := v_hits <= p_max;
  retry_after := greatest(1, p_window_seconds - floor(extract(epoch from (v_now - v_started)))::int);
  return next;
end;
$$;

-- Housekeeping: drop buckets whose window expired well in the past. Called from
-- the daily webhook-retry cron so the table can't accumulate stale rows.
create function prune_rate_limits()
returns void
language sql
as $$
  delete from rate_limit_hits where window_started_at < now() - interval '1 day';
$$;
