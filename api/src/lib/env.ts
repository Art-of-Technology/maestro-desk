import { z } from 'zod';

const Env = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
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
  PORT: z.coerce.number().int().positive().default(3001),
});

export const env = Env.parse(process.env);
export type Env = z.infer<typeof Env>;
