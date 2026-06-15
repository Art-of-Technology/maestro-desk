-- Make Maestro Connect brands the canonical workspace identity.
--
-- A Desk workspace becomes a local PROJECTION of a Maestro brand: the brand is
-- the source of truth for which workspaces exist and who can access them, while
-- the existing workspace_id FK graph (tickets, customers, roles, members, …)
-- stays exactly as-is. We link the two with a single nullable column.
--
--   - maestro_brand_id NULL  → a legacy/manually-provisioned workspace (the demo
--     seed, anything created via the God brand screen). These keep working —
--     the "keep existing logins" decision — they're just not Maestro-backed.
--   - maestro_brand_id SET   → a workspace auto-provisioned (or adopted) for a
--     Maestro brand on first agent sign-in. The unique index guarantees one
--     workspace per brand, so concurrent first sign-ins can't fork a brand into
--     two workspaces (the loser's UPDATE fails and the API uses the winner).
--
-- See api/src/lib/maestro-workspace.ts (find-or-provision + auto-membership)
-- and routes/maestro.ts POST /select-brand.

alter table workspaces add column if not exists maestro_brand_id uuid;

-- One workspace per brand. Partial + soft-delete-aware: only live, Maestro-
-- backed rows are constrained, so legacy NULLs and soft-deleted rows don't
-- collide.
create unique index if not exists workspaces_maestro_brand_id_unique
  on workspaces (maestro_brand_id)
  where maestro_brand_id is not null and deleted_at is null;
