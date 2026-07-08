-- Bound the cost of the audit-chain integrity check with per-workspace
-- checkpoints, so the DAILY verification is incremental (cost ∝ rows added since
-- last run) instead of recomputing every workspace's whole SHA-256 chain every
-- time (a full audit_events scan that grows without bound — a serverless-timeout
-- risk at volume).
--
-- audit_events_verify() (20260623120000) stays UNCHANGED as the authoritative,
-- read-only, full verifier — used by the manual /audit-verify endpoint. This
-- adds an INCREMENTAL verifier that resumes from a stored checkpoint; the WEEKLY
-- full re-scan runs it too, after wiping checkpoints (verify-from-genesis), so
-- automated detection has a single code path.
--
-- Detection tradeoff (deliberate): incremental catches tampering in new rows and
-- any historical tamper that rehashes the chain forward (it changes the
-- checkpointed head hash → the boundary prev_hash check fails). A historical
-- tamper that leaves the checkpointed head hash intact and does NOT cascade
-- forward (only possible by bypassing the append-only triggers) is caught by the
-- WEEKLY full re-scan (verifyAuditChains({resetFirst:true}) → wipes checkpoints →
-- re-verifies from genesis), not within 24h. Bounded ≤7-day latency for that one
-- class, in exchange for O(new-rows) daily cost.
--
-- Forward-only, like every migration here.

-- The last position whose chain was verified good, per workspace. Cascade-deletes
-- with the workspace, exactly like the chain rows it summarizes.
create table audit_verify_checkpoints (
  workspace_id  uuid primary key references workspaces(id) on delete cascade,
  last_seq      bigint not null,
  last_row_hash bytea not null,
  verified_at   timestamptz not null default now()
);

-- Incremental verifier. Same return shape as audit_events_verify(). Reuses
-- audit_events_rowhash() so the hash formula lives in exactly one place. Iterates
-- the (small) workspaces table rather than a DISTINCT over audit_events, so
-- enumeration is not itself a full scan; per workspace it reads only rows past
-- the checkpoint via the (workspace_id, seq) unique index. VOLATILE: it writes
-- checkpoints (unlike the read-only full verifier).
create or replace function audit_events_verify_incremental(p_workspace uuid default null)
returns table(workspace_id uuid, ok boolean, first_bad_seq bigint, first_bad_id uuid)
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  ws        record;
  r         record;
  prev      bytea;
  expected  bytea;
  bad_seq   bigint;
  bad_id    uuid;
  exp_seq   bigint;
  cp_seq    bigint;
  cp_hash   bytea;
  head_seq  bigint;
  head_hash bytea;
  saw_row   boolean;
begin
  for ws in
    select w.id as wid from workspaces w
    where p_workspace is null or w.id = p_workspace
  loop
    select cp.last_seq, cp.last_row_hash into cp_seq, cp_hash
    from audit_verify_checkpoints cp where cp.workspace_id = ws.wid;

    if cp_seq is null then
      prev := null; exp_seq := 1;                 -- verify from genesis
    else
      prev := cp_hash; exp_seq := cp_seq + 1;     -- resume from checkpoint
    end if;
    bad_seq := null; bad_id := null;
    head_seq := cp_seq; head_hash := cp_hash; saw_row := false;

    for r in
      select * from audit_events ae
      where ae.workspace_id = ws.wid
        and (cp_seq is null or ae.seq > cp_seq)
      order by ae.seq
    loop
      saw_row := true;
      if bad_seq is null then
        if r.seq <> exp_seq then
          bad_seq := exp_seq; bad_id := r.id;                       -- a row is missing
        else
          expected := audit_events_rowhash(prev, r.id, r.workspace_id, r.actor_user_id,
                                           r.actor_ip, r.actor_ua, r.action, r.target_type,
                                           r.target_id, r.metadata, r.created_at);
          if r.prev_hash is distinct from prev or r.row_hash is distinct from expected then
            bad_seq := r.seq; bad_id := r.id;                       -- altered row / severed prev
          end if;
        end if;
      end if;
      prev := r.row_hash;
      exp_seq := r.seq + 1;
      head_seq := r.seq; head_hash := r.row_hash;
    end loop;

    -- Only report/checkpoint workspaces that actually have a chain (new rows now,
    -- or a prior checkpoint). Advance the checkpoint only when the chain verified
    -- AND rows were actually verified this run (genesis, or head moved past the
    -- checkpoint). A zero-new-row run does NOT rewrite verified_at, so that
    -- timestamp honestly means "last time rows through last_seq were verified"
    -- (advanced incrementally, or re-verified by the weekly full) — it never
    -- claims freshness for a region only the weekly scan actually re-read.
    if cp_seq is not null or saw_row then
      if bad_seq is null and head_seq is not null and (cp_seq is null or head_seq > cp_seq) then
        -- Target the PK by constraint name: the RETURNS TABLE OUT parameter
        -- `workspace_id` shadows the column in an `on conflict (workspace_id)`
        -- inference clause ("column reference is ambiguous").
        insert into audit_verify_checkpoints (workspace_id, last_seq, last_row_hash, verified_at)
        values (ws.wid, head_seq, head_hash, now())
        on conflict on constraint audit_verify_checkpoints_pkey do update
          set last_seq = excluded.last_seq,
              last_row_hash = excluded.last_row_hash,
              verified_at = now();
      end if;
      workspace_id := ws.wid; ok := bad_seq is null;
      first_bad_seq := bad_seq; first_bad_id := bad_id;
      return next;
    end if;
  end loop;
end$$;
