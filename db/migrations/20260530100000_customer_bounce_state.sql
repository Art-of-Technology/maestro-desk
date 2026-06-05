-- Per-customer email bounce state. Updated by the Postmark bounce
-- webhook so the SPA can flag customers whose email is undeliverable
-- before an agent wastes time crafting a reply that will fail.
--
-- We denormalise the bounce summary onto customers rather than
-- maintaining a full event-history table. The history will land in
-- a follow-up if it's needed for compliance / postmortems — for now
-- the SPA only needs the current state + recent type + count.

alter table customers
  add column email_bounce_state      text not null default 'none'
    check (email_bounce_state in ('none', 'soft', 'hard', 'spam')),
  add column email_last_bounce_type  text,
  add column email_last_bounce_at    timestamptz,
  add column email_bounce_count      int  not null default 0;
