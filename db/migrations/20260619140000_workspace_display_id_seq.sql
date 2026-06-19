-- Per-workspace monotonic display-id sequences for tickets + customers.
--
-- Problem: display_ids were minted as `TK-<random 6 digits>` / `M<random 4
-- digits>`. Both tables have a unique (workspace_id, display_id) constraint, so
-- a collision doesn't create a duplicate — it makes the INSERT fail with 23505,
-- and there's no retry. At volume (especially customers: only ~9000 possible
-- values) those failures become routine. This replaces random generation with
-- an atomic per-workspace counter so ids are sequential and collision-free.

-- ─── 1. Counter table ───────────────────────────────────────────────────────
-- One row per (workspace, kind). last_value = the most recently allocated
-- number for that workspace+kind.
create table workspace_display_id_seq (
  workspace_id uuid   not null references workspaces(id) on delete cascade,
  kind         text   not null check (kind in ('ticket', 'customer')),
  last_value   bigint not null,
  primary key (workspace_id, kind)
);

-- ─── 2. Atomic allocator ────────────────────────────────────────────────────
-- Returns the next number for (workspace, kind), allocating row-and-value
-- atomically. First call for a pair inserts last_value = 1 and returns 1;
-- subsequent calls increment under a row lock, so concurrent inserts in the
-- same workspace serialise on this row and never collide.
create function alloc_display_id(p_workspace_id uuid, p_kind text)
returns bigint
language sql
as $$
  insert into workspace_display_id_seq (workspace_id, kind, last_value)
  values (p_workspace_id, p_kind, 1)
  on conflict (workspace_id, kind)
  do update set last_value = workspace_display_id_seq.last_value + 1
  returning last_value;
$$;

-- ─── 3. Seed existing workspaces above their current max ────────────────────
-- So the first sequential id is (max existing numeric suffix) + 1 and can never
-- collide with a legacy random id (all existing are <= that max). Workspaces
-- created after this migration get no seed row — their first alloc returns 1.
-- Numeric suffix = the digits in display_id (TK-001 -> 1, TK-483920 -> 483920,
-- M001 -> 1, M1234 -> 1234); rows with no digits coalesce to 0.
insert into workspace_display_id_seq (workspace_id, kind, last_value)
  select workspace_id, 'ticket',
         max(coalesce(nullif(regexp_replace(display_id, '\D', '', 'g'), '')::bigint, 0))
  from tickets
  group by workspace_id
on conflict (workspace_id, kind) do nothing;

insert into workspace_display_id_seq (workspace_id, kind, last_value)
  select workspace_id, 'customer',
         max(coalesce(nullif(regexp_replace(display_id, '\D', '', 'g'), '')::bigint, 0))
  from customers
  group by workspace_id
on conflict (workspace_id, kind) do nothing;
