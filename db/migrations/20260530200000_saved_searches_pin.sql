-- Pin a saved search as a view chip on the ticket list. Pinned
-- searches render alongside the built-in All / Needs attention /
-- Assigned to me / etc. chips for one-click access, instead of
-- going through the dropdown.
--
-- Only the OWNER can pin/unpin their own search. Shared+pinned
-- searches surface as chips for every workspace member (they're
-- already readable through the shared SELECT policy from PR #224);
-- the owner controls the pin state for everyone.

alter table saved_searches
  add column is_pinned boolean not null default false;
