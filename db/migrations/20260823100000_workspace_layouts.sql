-- Workspace-scoped layout persistence (Phase 4, PR 3).
--
-- Backs the admin Layouts screen, whose model was a module-level const in
-- web/js/layouts/index.js until now — every toggle reset on reload and was
-- private to one browser. Rows are DENSE per scope, not sparse: the PUT is a
-- full-desired-set replace for one scope, so a scope either has no rows at
-- all (code order + code defaults apply wholesale) or is fully persisted.
-- Elements added to the code later (no row yet) render after max(sort_order)
-- in code order, and read as visible — matching isFieldVisible's optimistic
-- unknown-key-means-visible behaviour.
--
-- scope ↔ client entity mapping (single source of truth is the comment block
-- on the /layouts routes in api/src/routes/workspace.ts):
--   ticket_form     ↔ FIELD_LAYOUTS.ticket   (new-ticket form fields)
--   customer_fields ↔ FIELD_LAYOUTS.customer (customer profile card fields)
--   customer_areas  ↔ profile page AREAS     (reserved for the area-reorder PR)

create table workspace_layouts (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  scope        text not null check (scope in ('ticket_form','customer_fields','customer_areas')),
  element_key  text not null,
  visible      boolean not null default true,
  required     boolean not null default false,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (workspace_id, scope, element_key),
  -- a hidden element can never be required (mirrors the API's zod invariant)
  check (visible or not required),
  -- 'required' is meaningless for whole page areas
  check (scope <> 'customer_areas' or required = false)
);

create trigger set_updated_at before update on workspace_layouts
  for each row execute function trigger_set_updated_at();
