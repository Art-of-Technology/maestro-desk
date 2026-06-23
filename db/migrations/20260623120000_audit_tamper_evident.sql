-- Tamper-evident, append-only hardening for audit_events (final GDPR/SOC2 item).
--
-- audit_events is our compliance evidence store (role changes, exports, GDPR
-- actions, auth events). For that evidence to be worth anything, an operator
-- with database access must not be able to silently rewrite or excise a row
-- to cover their tracks. Two controls, both enforced in the database so they
-- cover every insert path (writeAudit, the public portal, inbound webhooks)
-- with no application changes:
--
--   1. Append-only (preventive). UPDATE is never legitimate on an audit row,
--      so it is blocked outright. A targeted single-row DELETE is blocked too;
--      the only DELETE we permit is the ON DELETE CASCADE that fires when an
--      entire workspace is removed (GDPR erasure / test teardown) — that takes
--      the workspace's whole self-contained chain with it.
--   2. Tamper-evident (detective). Each row carries a SHA-256 hash chained to
--      the previous row in its workspace (row_hash = H(prev_hash || row data)),
--      plus a per-workspace contiguous seq. Altering a row breaks its hash;
--      deleting a row breaks the next row's prev_hash AND leaves a seq gap;
--      audit_events_verify() surfaces both. This is the backstop for the one
--      delete we allow and for anyone who disables the triggers — the math
--      still tells. (Residual risk: truncating the newest row(s) of a chain
--      leaves no gap or broken link; detecting that needs an external
--      high-water mark, out of scope here.)
--
-- Uses the built-in sha256(bytea) (PG 11+) — no pgcrypto dependency.
--
-- Forward-only: in keeping with every migration in this repo (migrate.ts tracks
-- applied files; there are no DOWN scripts), this has no down migration. An
-- append-only compliance table is the last thing that should be silently torn
-- down by an automated rollback anyway; reversing it is a deliberate manual act.

-- Ordering + chain columns. seq is a per-workspace contiguous counter (assigned
-- by the trigger under the per-workspace lock), giving a clock-independent total
-- order whose gaps are themselves evidence of a deleted row.
alter table audit_events
  add column seq       bigint,
  add column prev_hash bytea,
  add column row_hash  bytea;

-- Canonical row hash. Shared by the insert trigger, the backfill, and the
-- verifier so the formula lives in exactly one place. Each field is
-- LENGTH-PREFIXED (octet_length ':' value, nulls as a distinct 'N' marker)
-- before being joined, so the encoding is injective: no field value — even one
-- containing the '|' separator — can be shifted across a field boundary to
-- forge a colliding preimage. jsonb::text is normalized by Postgres, so
-- recomputation is deterministic. search_path is pinned so resolution of the
-- built-ins can't be hijacked.
-- Every persisted, security-relevant column is in the preimage. actor_ip and
-- actor_ua establish who acted from where, so they are protected by the chain
-- too — otherwise an adversary could rewrite the origin of an action without
-- breaking it. (actor_ip/actor_ua are NULL on the current insert paths but are
-- covered so any future writer that populates them is automatically protected.)
create or replace function audit_events_rowhash(
  p_prev        bytea,
  p_id          uuid,
  p_workspace   uuid,
  p_actor       uuid,
  p_actor_ip    inet,
  p_actor_ua    text,
  p_action      text,
  p_target_type text,
  p_target_id   uuid,
  p_metadata    jsonb,
  p_created_at  timestamptz
) returns bytea
language sql immutable
set search_path = pg_catalog, public
as $$
  select sha256(convert_to(
    (case when p_prev is null then 'N'
          else octet_length(encode(p_prev,'hex'))::text || ':' || encode(p_prev,'hex') end) || '|' ||
    (octet_length(p_id::text)::text          || ':' || p_id::text)        || '|' ||
    (octet_length(p_workspace::text)::text   || ':' || p_workspace::text) || '|' ||
    (case when p_actor is null then 'N'
          else octet_length(p_actor::text)::text || ':' || p_actor::text end) || '|' ||
    (case when p_actor_ip is null then 'N'
          else octet_length(p_actor_ip::text)::text || ':' || p_actor_ip::text end) || '|' ||
    (case when p_actor_ua is null then 'N'
          else octet_length(p_actor_ua)::text || ':' || p_actor_ua end) || '|' ||
    (case when p_action is null then 'N'
          else octet_length(p_action)::text || ':' || p_action end) || '|' ||
    (case when p_target_type is null then 'N'
          else octet_length(p_target_type)::text || ':' || p_target_type end) || '|' ||
    (case when p_target_id is null then 'N'
          else octet_length(p_target_id::text)::text || ':' || p_target_id::text end) || '|' ||
    (case when p_metadata is null then 'N'
          else octet_length(p_metadata::text)::text || ':' || p_metadata::text end) || '|' ||
    (octet_length(p_created_at::text)::text  || ':' || p_created_at::text),
    'UTF8'));
$$;

-- Backfill existing rows into a continuous per-workspace chain (seq starts at 1
-- per workspace). Runs BEFORE the append-only triggers exist, so these UPDATEs
-- are permitted.
do $$
declare
  r      record;
  prev   bytea;
  cur_ws uuid;
  n      bigint;
begin
  cur_ws := null;
  prev   := null;
  n      := 0;
  for r in
    select * from audit_events order by workspace_id, created_at, id
  loop
    if cur_ws is distinct from r.workspace_id then
      cur_ws := r.workspace_id;
      prev   := null;
      n      := 0;
    end if;
    n := n + 1;
    update audit_events set
      seq       = n,
      prev_hash = prev,
      row_hash  = audit_events_rowhash(prev, r.id, r.workspace_id, r.actor_user_id,
                                       r.actor_ip, r.actor_ua, r.action, r.target_type,
                                       r.target_id, r.metadata, r.created_at)
    where id = r.id
    returning row_hash into prev;
  end loop;
end$$;

-- Now the columns the trigger maintains are mandatory. seq is unique per
-- workspace (not globally — it restarts at 1 for each chain).
alter table audit_events alter column seq      set not null;
alter table audit_events alter column row_hash set not null;
create unique index audit_events_workspace_seq_uniq on audit_events (workspace_id, seq);

-- Chain extension on insert. Serialize per workspace so two concurrent inserts
-- can't both read the same tail and fork the chain (or collide on seq).
create or replace function audit_events_chain() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  prev     bytea;
  last_seq bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('audit_events:' || new.workspace_id::text, 0));

  select seq, row_hash into last_seq, prev
  from audit_events
  where workspace_id = new.workspace_id
  order by seq desc
  limit 1;

  new.seq       := coalesce(last_seq, 0) + 1;  -- 1 for the first row in a chain
  new.prev_hash := prev;                       -- null = first row in this chain
  new.row_hash  := audit_events_rowhash(prev, new.id, new.workspace_id, new.actor_user_id,
                                        new.actor_ip, new.actor_ua, new.action,
                                        new.target_type, new.target_id,
                                        new.metadata, new.created_at);
  return new;
end$$;

create trigger audit_events_chain_ins
  before insert on audit_events
  for each row execute function audit_events_chain();

-- Append-only enforcement. UPDATE always blocked; DELETE blocked unless the
-- parent workspace is already gone (i.e. this is a cascade taking the whole
-- chain, not a surgical row removal).
create or replace function audit_events_immutable() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'audit_events is append-only: UPDATE is not permitted (id=%)', old.id
      using errcode = 'check_violation';
  end if;
  -- tg_op = 'DELETE'
  if exists (select 1 from workspaces where id = old.workspace_id) then
    raise exception 'audit_events is append-only: direct DELETE is not permitted (id=%)', old.id
      using errcode = 'check_violation';
  end if;
  return old;
end$$;

create trigger audit_events_no_update
  before update on audit_events
  for each row execute function audit_events_immutable();

create trigger audit_events_no_delete
  before delete on audit_events
  for each row execute function audit_events_immutable();

-- Verifier: recompute each workspace's chain and report the first broken link.
-- Two independent detectors per workspace:
--   * seq gap     — seq is contiguous from 1, so a hole means a row was deleted.
--   * hash break  — an altered row (row_hash mismatch) or an altered/severed
--                   prev pointer (prev_hash mismatch).
-- Returns one row per workspace; ok = false pinpoints the earliest bad seq/id
-- (for a gap, the missing seq). Pass a workspace id to check one, or null for
-- all. Stable / read-only — safe to wire to a Vercel Cron compliance check.
create or replace function audit_events_verify(p_workspace uuid default null)
returns table(workspace_id uuid, ok boolean, first_bad_seq bigint, first_bad_id uuid)
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare
  r            record;
  prev         bytea;
  cur          uuid;
  expected     bytea;
  bad_seq      bigint;
  bad_id       uuid;
  expected_seq bigint;
begin
  cur := null;
  for r in
    select * from audit_events ae
    where p_workspace is null or ae.workspace_id = p_workspace
    order by ae.workspace_id, ae.seq
  loop
    if cur is distinct from r.workspace_id then
      if cur is not null then
        workspace_id := cur; ok := bad_seq is null;
        first_bad_seq := bad_seq; first_bad_id := bad_id; return next;
      end if;
      cur := r.workspace_id; prev := null; bad_seq := null; bad_id := null; expected_seq := 1;
    end if;
    if bad_seq is null then
      if r.seq <> expected_seq then
        bad_seq := expected_seq; bad_id := r.id;       -- a row is missing
      else
        expected := audit_events_rowhash(prev, r.id, r.workspace_id, r.actor_user_id,
                                         r.actor_ip, r.actor_ua, r.action, r.target_type,
                                         r.target_id, r.metadata, r.created_at);
        if r.prev_hash is distinct from prev or r.row_hash is distinct from expected then
          bad_seq := r.seq; bad_id := r.id;            -- a row was altered
        end if;
      end if;
    end if;
    prev := r.row_hash;
    expected_seq := r.seq + 1;
  end loop;
  if cur is not null then
    workspace_id := cur; ok := bad_seq is null;
    first_bad_seq := bad_seq; first_bad_id := bad_id; return next;
  end if;
end$$;
