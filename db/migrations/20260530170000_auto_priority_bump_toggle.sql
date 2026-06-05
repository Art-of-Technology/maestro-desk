-- Per-workspace toggle for the angry-sentiment → high-priority bump
-- introduced in PR #213. Defaults to true so the existing behaviour
-- stays the default for new and existing workspaces (matches what
-- they've been getting since #213 merged).
--
-- Workspaces flip it to false when:
--   - they want sentiment SCORING (badge + filter + reports) without
--     automatic priority changes
--   - they have their own workflow engine path that already handles
--     angry escalation and want to avoid duplicate bumps

alter table workspaces
  add column auto_priority_bump_on_angry boolean not null default true;
