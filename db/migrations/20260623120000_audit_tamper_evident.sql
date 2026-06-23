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
--      the previous row in its workspace (row_hash = H(prev_hash || row data)).
--      Altering or removing any row breaks every link after it, which
--      audit_events_verify() surfaces. This is the backstop for the one delete
--      we allow and for anyone who disables the triggers: the math still tells.
--
-- Uses the built-in sha256(bytea) (PG 11+) — no pgcrypto dependency.

-- Ordering + chain columns. seq gives a clock-independent total order per
-- workspace (created_at can tie or skew); the trigger fills all three.
alter table audit_events
  add column seq       bigint,
  add column prev_hash bytea,
  add column row_hash  bytea;

create sequence if not exists audit_events_seq_seq owned by audit_events.seq;

-- Canonical row hash. Shared by the insert trigger, the backfill, and the
-- verifier so the formula lives in exactly one place. jsonb::text is
-- normalized by Postgres, so recomputation is deterministic.
create or replace function audit_events_rowhash(
  p_prev        bytea,
  p_id          uuid,
  p_workspace   uuid,
  p_actor       uuid,
  p_action      text,
  p_target_type text,
  p_target_id   uuid,
  p_metadata    jsonb,
  p_created_at  timestamptz
) returns bytea
language sql immutable as $$
  select sha256(convert_to(
    coalesce(encode(p_prev, 'hex'), '') || '|' ||
    p_id::text                          || '|' ||
    p_workspace::text                   || '|' ||
    coalesce(p_actor::text, '')         || '|' ||
    coalesce(p_action, '')              || '|' ||
    coalesce(p_target_type, '')         || '|' ||
    coalesce(p_target_id::text, '')     || '|' ||
    coalesce(p_metadata::text, '')      || '|' ||
    p_created_at::text,
    'UTF8'));
$$;

-- Backfill existing rows into a continuous per-workspace chain. Runs BEFORE the
-- append-only triggers exist, so the UPDATEs here are permitted.
do $$
declare
  r      record;
  prev   bytea;
  cur_ws uuid;
begin
  cur_ws := null;
  prev   := null;
  for r in
    select * from audit_events order by workspace_id, created_at, id
  loop
    if cur_ws is distinct from r.workspace_id then
      cur_ws := r.workspace_id;
      prev   := null;
    end if;
    update audit_events set
      seq       = nextval('audit_events_seq_seq'),
      prev_hash = prev,
      row_hash  = audit_events_rowhash(prev, r.id, r.workspace_id, r.actor_user_id,
                                       r.action, r.target_type, r.target_id,
                                       r.metadata, r.created_at)
    where id = r.id
    returning row_hash into prev;
  end loop;
end$$;

-- Now the columns the trigger maintains are mandatory.
alter table audit_events alter column seq      set not null;
alter table audit_events alter column row_hash set not null;
create unique index audit_events_seq_uniq           on audit_events (seq);
create unique index audit_events_workspace_seq_uniq on audit_events (workspace_id, seq);

-- Chain extension on insert. Serialize per workspace so two concurrent inserts
-- can't both read the same tail and fork the chain.
create or replace function audit_events_chain() returns trigger
language plpgsql as $$
declare
  prev bytea;
begin
  perform pg_advisory_xact_lock(hashtextextended('audit_events:' || new.workspace_id::text, 0));

  new.seq := nextval('audit_events_seq_seq');

  select row_hash into prev
  from audit_events
  where workspace_id = new.workspace_id
  order by seq desc
  limit 1;

  new.prev_hash := prev;  -- null = first row in this workspace's chain
  new.row_hash  := audit_events_rowhash(prev, new.id, new.workspace_id, new.actor_user_id,
                                        new.action, new.target_type, new.target_id,
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
language plpgsql as $$
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

-- Verifier: recompute each workspace's chain and report the first broken link
-- (altered row, altered prev pointer, or a hole left by a deleted row). Returns
-- one row per workspace; ok = false pinpoints the earliest tampered seq/id.
-- Pass a workspace id to check one, or null for all. Stable / read-only — safe
-- to wire to a Vercel Cron compliance check.
create or replace function audit_events_verify(p_workspace uuid default null)
returns table(workspace_id uuid, ok boolean, first_bad_seq bigint, first_bad_id uuid)
language plpgsql stable as $$
declare
  r        record;
  prev     bytea;
  cur      uuid;
  expected bytea;
  bad_seq  bigint;
  bad_id   uuid;
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
      cur := r.workspace_id; prev := null; bad_seq := null; bad_id := null;
    end if;
    if bad_seq is null then
      expected := audit_events_rowhash(prev, r.id, r.workspace_id, r.actor_user_id,
                                       r.action, r.target_type, r.target_id,
                                       r.metadata, r.created_at);
      if r.prev_hash is distinct from prev or r.row_hash is distinct from expected then
        bad_seq := r.seq; bad_id := r.id;
      end if;
    end if;
    prev := r.row_hash;
  end loop;
  if cur is not null then
    workspace_id := cur; ok := bad_seq is null;
    first_bad_seq := bad_seq; first_bad_id := bad_id; return next;
  end if;
end$$;
