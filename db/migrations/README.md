# Neon SQL migrations

Plain `.sql` migrations applied to **Neon** in filename order by the runner:

```bash
cd api && bun run migrate
```

The runner (`api/scripts/migrate.ts`) records each applied file in the
`schema_migrations` table, so re-running only applies new files. Each file
runs in its own transaction.

## Provenance — ported from `supabase/migrations/` (Step 1 of the Neon migration)

These files were ported 1:1 from the legacy Supabase migrations, **structure
only**. The Supabase-specific security layer was deliberately left out because
it is being rebuilt elsewhere in the migration:

| Supabase construct | Where it goes instead |
|---|---|
| RLS policies (`enable row level security`, `create policy`) | **Step 3** — per-route authorization in Hono middleware |
| `auth.uid()`, `auth.users`, the custom access-token hook | **Step 2** — Better Auth (owns its own user tables) |
| `grant`/`revoke` to `authenticated`/`anon`/`service_role` | **Step 3** — the API connects as the DB owner; authz is in middleware |
| `storage.*` buckets/objects | **Step 4** — Cloudflare R2 |

### What was done to each legacy file
- **Copied verbatim** — the 38 files that were already pure structural DDL
  (tables, indexes, functions, triggers, extensions, seed data).
- **Stripped** — 13 files had a trailing RLS/grant block removed, keeping the
  table/column/function definitions above it (e.g. `ai_triage_columns`,
  `workspace_email_domains`, `outgoing_webhooks`, `saved_searches`,
  `generic_presence`, the `provision_brand` functions, `platform_admin` —
  which keeps its `is_platform_admin` *column* but drops the `auth.uid()`-based
  *function*).
- **Omitted entirely** — 22 files that were purely RLS / grants / the auth hook
  / storage buckets, with no structural content. Notably:
  `*_rls_pivot.sql` (all), `rls_policies.sql`, `grants.sql`,
  `platform_admin_rls.sql`, `custom_access_token_hook.sql`,
  `fix_hook_return_shape.sql`, `integration_tables_rls.sql`,
  `workspace_members_admin_writes.sql`, `ticket_viewers_workspace_check.sql`,
  `brand_assets_bucket.sql`, `portal_auth_enable_rls.sql`,
  `pin_function_search_path.sql`, `advisor_executable_hardening.sql`,
  `revoke_authenticated_mutating_fns.sql`.

### Notes
- `current_workspace_id()` (in `..._extensions_and_helpers.sql`) reads a
  Supabase JWT setting. It is kept because it creates cleanly on Neon (returns
  null when unset) and nothing structural depends on it. It can be removed once
  Step 3's authz model is in place.
- Applying all files from an empty database produces **53 tables, 0 with RLS**
  — verified. The old `supabase/migrations/` folder is retained untouched for
  reference during the migration.
