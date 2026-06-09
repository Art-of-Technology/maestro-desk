import { z } from 'zod';

const Env = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  // Neon Postgres connection string (migration to Neon — Step 1).
  // Format: postgresql://user:pass@<host>.neon.tech/<db>?sslmode=require
  // Optional for now: Supabase is still the live database, so the app must
  // boot without it (CI, existing dev). lib/db.ts throws a clear error if it
  // is used while unset. Becomes required at the production cutover step.
  DATABASE_URL: z.string().url().optional(),
  // Better Auth (migration to Neon — Step 2). Owns sessions/users sign-in.
  // SECRET signs sessions/tokens — generate with `openssl rand -base64 32`.
  // URL is the API's own base URL (where Better Auth's /api/auth/* is served).
  // Both optional for now so the app still boots mid-migration; Better Auth
  // warns + uses a dev fallback when the secret is unset.
  // Min 32 chars — Better Auth's own recommended length (`openssl rand -base64
  // 32`). Optional only because the app must still boot mid-migration while
  // Better Auth is dormant; it becomes required at the Step 3 cutover.
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  BETTER_AUTH_URL: z.string().url().default('http://localhost:3001'),
  ANTHROPIC_API_KEY: z.string().min(20),
  // Secret Postmark passes as a query string on the inbound webhook URL:
  // https://<tunnel-host>/api/v1/webhooks/postmark/inbound?secret=<value>
  // (URL-embedded Basic Auth is rejected by Postmark's URL validator.)
  POSTMARK_INBOUND_SECRET: z.string().min(16),
  // Outbound — Server API Token from Postmark (Settings → API Tokens).
  // Verified sender address (Sender Signatures or domain-verified).
  // Auto-reply is skipped at runtime if either is empty.
  POSTMARK_SERVER_TOKEN: z.string().default(''),
  POSTMARK_OUTBOUND_FROM: z.string().default(''),
  // Account-level token (Postmark UI → Account → API Tokens). REQUIRED for
  // the Postmark Domains API (provisioning per-brand sender domains).
  // Distinct from POSTMARK_SERVER_TOKEN above — that one's per-server (for
  // sending mail), this one's per-account (for managing senders + domains).
  // When empty, the domain-add API still creates the local workspace_email_
  // domains row but skips Postmark provisioning; the brand can re-trigger
  // via POST /api/v1/god/brands/:id/domains/:domainId/verify once configured.
  POSTMARK_ACCOUNT_TOKEN: z.string().default(''),
  // Postmark inbound stream address — set as Reply-To on outbound so
  // customer replies route back through the webhook (closing the loop).
  // Find under Postmark → Servers → <server> → Default Inbound Stream →
  // Settings — the "@inbound.postmarkapp.com" address at the top.
  // Empty means replies fall back to the From address.
  POSTMARK_INBOUND_REPLY_ADDRESS: z.string().default(''),
  // Public-facing base URL of the customer portal. Used to build links
  // we embed in outbound emails (CSAT surveys, CSAT reminders, magic-
  // link sign-in fallback). Should include the protocol and path to
  // portal.html — e.g. https://help.acme.com/portal.html. Empty in
  // dev: csat code falls back to http://localhost:5173/portal.html,
  // and the magic-link path derives a URL from the request origin.
  PORTAL_BASE_URL: z.string().default(''),
  // Cloudflare R2 (migration to Neon — Step 4). Replaces Supabase Storage
  // for brand-asset uploads (workspace logos). R2 is S3-compatible; we sign
  // requests with aws4fetch (region "auto") rather than an AWS SDK so the
  // same code runs on Bun locally and Node on Vercel.
  //   ACCOUNT_ID    → the S3 endpoint host: <id>.r2.cloudflarestorage.com
  //   ACCESS_KEY_ID / SECRET_ACCESS_KEY → an R2 API token (S3 credentials)
  //   BUCKET        → bucket name, e.g. "brand-assets"
  //   PUBLIC_BASE_URL → the bucket's public read base (r2.dev URL or a
  //                     custom domain), used to build the stored logo_url.
  // All optional mid-migration: lib/r2.ts throws a clear error if used while
  // unset, so the API still boots (and routes that don't upload still work)
  // until R2 is provisioned. Becomes required once logo upload is live.
  R2_ACCOUNT_ID: z.string().default(''),
  R2_ACCESS_KEY_ID: z.string().default(''),
  R2_SECRET_ACCESS_KEY: z.string().default(''),
  R2_BUCKET: z.string().default('brand-assets'),
  R2_PUBLIC_BASE_URL: z.string().default(''),
  PORT: z.coerce.number().int().positive().default(3001),
});

export const env = Env.parse(process.env);
export type Env = z.infer<typeof Env>;
