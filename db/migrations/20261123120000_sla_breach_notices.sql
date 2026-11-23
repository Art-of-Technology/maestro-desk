-- One row per ticket whose SLA breach has been announced to outgoing webhooks
-- (event sla.breach). The row is the "already told" marker: the sweep in
-- api/src/lib/sla-breach-worker.ts claims a ticket by inserting here, so a
-- ticket is announced at most once, however many API instances sweep.
--
-- Kept in its own table rather than as a tickets column so that recording a
-- notice does not touch the ticket row (and its updated_at, which drives
-- list order and sync).
create table ticket_sla_breach_notices (
  ticket_id    uuid primary key references tickets(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  target       text not null check (target in ('first_response', 'resolution', 'preexisting')),
  notified_at  timestamptz not null default now()
);

-- Every ticket that exists at release is marked as already handled. Without
-- this the first sweep would announce every old ticket that breached long
-- ago. Trade-off: tickets created before this release never send sla.breach.
insert into ticket_sla_breach_notices (ticket_id, workspace_id, target)
select id, workspace_id, 'preexisting' from tickets;
