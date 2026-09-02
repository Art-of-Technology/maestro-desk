-- Multiple emails / mobiles per customer, with one primary per kind
-- (Phase 4, PR 5 — the customer-profile overhaul's data-model half).
--
-- Until now a customer had exactly one customers.email (citext, unique per
-- workspace) and one customers.mobile (text, no uniqueness). This table holds
-- N addresses of each kind. customers.email / customers.mobile are KEPT as a
-- read-only MIRROR of the primary row of each kind, maintained in application
-- code by api/src/lib/customer-contacts.ts (never by a trigger — a trigger
-- keyed on the contact row would take a customers row lock on every write
-- while the merge transaction locks customers first and contacts second: an
-- ABBA deadlock). Everything that reads the scalars keeps working unchanged.
--
-- One polymorphic table, not two: emails and mobiles share the whole
-- add / remove / set-primary / merge / erase lifecycle. The only asymmetry is
-- deliverability, pinned to email rows by the check constraint below.
--
-- Uniqueness: an EMAIL belongs to one live profile per workspace (it is the
-- identity key for inbound mail, the portal and the Maestro lookup). Mobiles
-- are NOT identity keys — customers.mobile was never unique, so two live
-- profiles may legitimately share a number (a household) and a workspace-wide
-- index would have failed this very backfill. Both kinds are unique per
-- profile (no duplicate value on one customer).
--
-- The email index cannot see customers.deleted_at / erased_at, so the two
-- customer lifecycle paths write this table in the same transaction:
-- DELETE /customers/:id soft-deletes the rows (address freed, recoverable like
-- the profile) and GDPR erasure HARD-deletes them (a soft-deleted row would
-- keep the address as personal data forever).
--
-- Merge bookkeeping mirrors customer_notes.merged_from_customer_id: a merge
-- MOVES the source's rows onto the survivor stamped with the source id and the
-- primary flag they held, so unmerge can put them back exactly.

create table if not exists customer_contacts (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  customer_id  uuid not null references customers(id) on delete cascade,
  kind         text not null check (kind in ('email', 'mobile')),
  value        citext not null,
  is_primary   boolean not null default false,
  -- email deliverability (moved off customers.email_bounce_*; email rows only)
  bounce_state     text not null default 'none'
                   check (bounce_state in ('none', 'soft', 'hard', 'spam')),
  bounce_last_type text,
  bounce_last_at   timestamptz,
  bounce_count     int not null default 0,
  -- merge bookkeeping
  merged_from_customer_id uuid references customers(id),
  primary_before_merge    boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  check (kind = 'email' or (bounce_state = 'none' and bounce_count = 0
         and bounce_last_type is null and bounce_last_at is null))
);

-- An email belongs to ONE live profile per workspace (see header).
create unique index if not exists customer_contacts_email_unique
  on customer_contacts (workspace_id, value)
  where kind = 'email' and deleted_at is null;

-- No duplicate value on one profile, either kind.
create unique index if not exists customer_contacts_per_customer_unique
  on customer_contacts (customer_id, kind, value)
  where deleted_at is null;

-- Exactly one primary per kind per profile. A plain partial unique index, NOT
-- a deferrable constraint, so it is checked per row: flipping the primary is
-- two statements (clear, then set) inside one transaction.
create unique index if not exists customer_contacts_one_primary
  on customer_contacts (customer_id, kind)
  where is_primary and deleted_at is null;

create index if not exists customer_contacts_customer_idx
  on customer_contacts (workspace_id, customer_id)
  where deleted_at is null;

-- Merge/unmerge and the merged-away profile's display both read by stamp.
create index if not exists customer_contacts_merged_from_idx
  on customer_contacts (workspace_id, merged_from_customer_id)
  where merged_from_customer_id is not null;

create or replace trigger set_updated_at before update on customer_contacts
  for each row execute function trigger_set_updated_at();

-- ─── Backfill ────────────────────────────────────────────────────────────────
-- One primary row per non-blank scalar. Soft-deleted profiles carry their
-- deleted_at across so their addresses stay freed (the old partial index
-- excluded them too). Erased profiles have null scalars and get no rows.
-- Bounce state rides along on the email row — without it, PR 7's move of the
-- suppression read onto the contact row would make every known-dead address
-- sendable again.
--
-- Deliberately NO `on conflict` clause: the only index this can hit is the
-- workspace-wide email index, and customers_workspace_email_unique already
-- guarantees that cannot happen over live rows. If it does, a loud failure at
-- boot is the right outcome — a silently dropped row would leave a customer
-- with a scalar and no contact, the exact state the app code's self-heal
-- exists to repair. `where not exists` keeps the file re-runnable.
insert into customer_contacts
  (workspace_id, customer_id, kind, value, is_primary,
   bounce_state, bounce_last_type, bounce_last_at, bounce_count,
   created_at, deleted_at)
select c.workspace_id, c.id, 'email', c.email, true,
       coalesce(c.email_bounce_state, 'none'), c.email_last_bounce_type, c.email_last_bounce_at,
       coalesce(c.email_bounce_count, 0),
       c.created_at, c.deleted_at
from customers c
where nullif(trim(c.email::text), '') is not null
  and not exists (
    select 1 from customer_contacts cc where cc.customer_id = c.id and cc.kind = 'email'
  )
order by c.created_at, c.id;

insert into customer_contacts
  (workspace_id, customer_id, kind, value, is_primary, created_at, deleted_at)
select c.workspace_id, c.id, 'mobile', trim(c.mobile), true, c.created_at, c.deleted_at
from customers c
where nullif(trim(c.mobile), '') is not null
  and not exists (
    select 1 from customer_contacts cc where cc.customer_id = c.id and cc.kind = 'mobile'
  )
order by c.created_at, c.id;

-- GDPR erasure and the subject-access export match un-converted inbox mail by
-- sender address — now EVERY address the customer has held, via
-- `lower(from_email::text) = any(<addresses>)` (lower() on both sides keeps the
-- comparison case-insensitive regardless of how the text[] parameter is
-- typed). from_email had no index at all (sequential scan per request); this
-- expression index matches that predicate exactly.
create index if not exists inbox_messages_ws_from_email_lower
  on inbox_messages (workspace_id, lower(from_email::text));
