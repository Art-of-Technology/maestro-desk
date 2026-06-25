-- Coarse "is this agent currently in the app?" signal for offline-notification
-- routing. The presence table is per-entity (who's viewing THIS ticket, 15s
-- TTL) and clears on every page change, so it can't answer "is the agent in
-- the desk at all". last_active_at is stamped from the always-on ~60s list-sync
-- poll (every logged-in agent, every page), so "offline" = no activity within
-- a few minutes. Nullable: existing/never-active users read as offline.
alter table users
  add column if not exists last_active_at timestamptz;
