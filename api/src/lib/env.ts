import { z } from 'zod';

const Env = z.object({
  // Neon Postgres connection string — the source of truth now that the
  // Supabase→Neon migration is complete. Required: every route + Better Auth
  // read through it.
  // Format: postgresql://user:pass@<host>.neon.tech/<db>?sslmode=require
  DATABASE_URL: z.string().url(),
  // Better Auth (migration to Neon — Step 2). Owns sessions/users sign-in.
  // SECRET signs sessions/tokens — generate with `openssl rand -base64 32`.
  // URL is the API's own base URL (where Better Auth's /api/auth/* is served).
  // Both optional for now so the app still boots mid-migration; Better Auth
  // warns + uses a dev fallback when the secret is unset.
  // Min 32 chars — Better Auth's own recommended length (`openssl rand -base64
  // 32`). REQUIRED as of the Step 3 auth cutover: Better Auth is now the live
  // auth system, so the app must not boot without a real secret.
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url().default('http://localhost:3001'),
  // Public origin of the agent SPA (where index.html is served). Used as a
  // Better Auth trusted origin and to build the password-reset link emailed to
  // invited/reset users (`${APP_BASE_URL}/?reset_token=...`). Dev default is
  // the local static server; set to https://desk.maestro-desk.com in prod.
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
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
  // Pubby realtime (migration — Step 5). Pusher-compatible push for live
  // ticket/message updates. All optional: when unset, lib/pubby.ts no-ops and
  // the SPA falls back to polling, so realtime is purely additive.
  //   APP_ID/KEY/SECRET → server PubbyServer (KEY is the public app key; the
  //     SPA also receives it). SECRET signs trigger + channel-auth.
  //   WS_HOST → the client's WebSocket host (e.g. wss://ws.pubby.dev), served
  //     to the SPA via GET /api/v1/pubby/config.
  //   API_HOST → optional override of the server HTTP API (default
  //     https://api.pubby.dev, where triggers POST).
  PUBBY_APP_ID: z.string().default(''),
  PUBBY_KEY: z.string().default(''),
  PUBBY_SECRET: z.string().default(''),
  PUBBY_WS_HOST: z.string().default(''),
  PUBBY_API_HOST: z.string().default(''),
  PORT: z.coerce.number().int().positive().default(3001),
});

export const env = Env.parse(process.env);
export type Env = z.infer<typeof Env>;
