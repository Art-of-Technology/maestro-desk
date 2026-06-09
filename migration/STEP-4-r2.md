# Step 4 — File storage → Cloudflare R2

Move brand-asset uploads (workspace logos) off **Supabase Storage** onto **Cloudflare R2** (S3-compatible API). This is the last non-auth piece of Supabase: after it, the only remaining Supabase usage is authentication + the god/audit surface, which all flip together in **Step 3.final**.

Ordering: per the locked plan, **Step 4 lands before the auth-token flip** — we don't want to remove `@supabase/supabase-js` (3.final) while Storage still depends on it.

## Scope (what actually used Supabase Storage)

A single endpoint: `POST /api/v1/workspace/branding/logo` (`api/src/routes/workspace.ts`). It uploaded the file to the `brand-assets` bucket, cleaned up the workspace's older logos, derived a public URL, and wrote it to `workspaces.logo_url` (already on Neon). Nothing else in the codebase touches `.storage.*`.

The SPA is unchanged: it POSTs multipart `file` and reads back `{ logo_url }` (`js/settings/index.js`). Only the URL host changes (Supabase public bucket → R2 public base).

## Approach

- **No AWS SDK, no `Bun.S3Client`.** The API runs on Bun today but moves to **Vercel's Node runtime** in Step 6, so the storage client must be runtime-agnostic. Use **`aws4fetch`** — a tiny (zero-dependency) SigV4 signer over `fetch` + Web Crypto that runs identically on Bun and Node. Matches the repo's "Postmark via plain fetch, no SDK" convention.
- New lib **`api/src/lib/r2.ts`**: lazy + memoised `AwsClient` (`region: 'auto'`, `service: 's3'`), mirroring `lib/db.ts`. Exports `putObject`, `listKeys(prefix)`, `deleteKeys(keys)`, `publicUrl(key)`. Throws a clear error if R2 env is unset, so the API still boots unconfigured.
- Object key unchanged: `${workspaceId}/logo-${Date.now()}.${ext}`.
- Cleanup: `ListObjectsV2` under the workspace prefix → per-object `DELETE` for stale keys (best-effort; tiny set).
- Public URL: `${R2_PUBLIC_BASE_URL}/${key}` (R2 has no auto public URL from the S3 endpoint; the bucket's r2.dev URL or custom domain provides public read).

## Env contract (added to `lib/env.ts` + `.env.example`, all optional mid-migration)

| Var | Purpose |
|---|---|
| `R2_ACCOUNT_ID` | S3 endpoint host `<id>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 API token (Object Read & Write) |
| `R2_BUCKET` | bucket name (default `brand-assets`) |
| `R2_PUBLIC_BASE_URL` | public read base (r2.dev URL or custom domain), no trailing slash |

## Checklist

- [x] Add R2 env vars (Zod, optional) + document in `.env.example`.
- [x] `api/src/lib/r2.ts` (aws4fetch wrapper, lazy, clear-error-if-unset).
- [x] Rewrite logo handler to use R2; `workspace.ts` no longer imports Supabase.
- [x] Add `aws4fetch` dep; `bun install`.
- [x] `bun run typecheck` + `bun test` green.
- [ ] **👤 Provision R2** (owner): create `brand-assets` bucket, an R2 API token, enable the public r2.dev URL (or attach a custom domain), and fill the 5 vars in `api/.env`. Then upload a logo from Settings → confirm it renders from the R2 URL.
- [ ] PR + Octopus loop to 4+/5.

## Notes

- Old logos already in Supabase Storage are **not** migrated — `logo_url` is rewritten on the next upload. If any live workspace has a logo, re-upload it once after cutover (only `demo`/`Maestro-Desk` exist today).
- Public access is granted at the bucket level in Cloudflare; the public base URL is not signed.
