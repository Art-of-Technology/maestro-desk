-- Per-ticket throttle for offline-agent push (push stage 3). Set when we push
-- the assigned agent about a new customer reply; cleared when the agent next
-- replies (they're handling it again). While set, further customer replies on
-- the same ticket don't re-push — so a fast back-and-forth fires one push, not
-- a burst.
alter table tickets
  add column if not exists last_reply_notified_at timestamptz;
