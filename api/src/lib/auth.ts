import { betterAuth } from 'better-auth';
import { bearer, genericOAuth } from 'better-auth/plugins';
import { Pool } from 'pg';
import { env } from './env.js';
import { sendEmail, isPostmarkConfigured } from './postmark-outbound.js';

// "Sign in with Maestro" (Maestro Connect OIDC). Only mounted when the app's
// OAuth client credentials are configured — when they're absent (e.g. a dev
// box that hasn't wired Maestro yet) the provider simply isn't registered and
// the SPA hides the button. Compliant with the "Better Auth only" guardrail:
// Maestro is an OIDC *provider* feeding Better Auth, not a separate auth system.
export const MAESTRO_PROVIDER_ID = 'maestro';
export const maestroSignInEnabled = Boolean(env.MAESTRO_CLIENT_ID && env.MAESTRO_CLIENT_SECRET);

// The exact scope set the manifest's oauth.scopes declares. DRAFT apps are
// capped at openid/profile/email at authorize time; the rest unlock once the
// app is ACTIVE (see `maestro integrate` — "DRAFT apps have a scope ceiling").
const MAESTRO_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',        // → refresh token, so getAccessToken can refresh
  'organizations:read',
  'brands:read',
  'members:read',
  'members:balance',
  'transactions:read',
  'bonuses:read',
  'rg:read',
];

// Better Auth (migration to Neon — Step 2). Owns sign-in, sessions, and the
// users/account/session/verification tables in Neon. Replaces Supabase Auth.
//
// Decisions (see migration/STEP-2-better-auth.md):
//   - Driver: a dedicated `pg` Pool here. The rest of the API uses the
//     `postgres` (porsager) client for raw SQL; Better Auth gets its own pool.
//   - Session transport: bearer tokens (matches the SPA's existing
//     `Authorization: Bearer` + sessionStorage pattern).
//   - User table: mapped onto the EXISTING `users` table so every existing FK
//     (workspace_members, tickets, …) keeps pointing at the same uuid ids.
//     New users get their id from the table's `gen_random_uuid()` default
//     (generateId: false), keeping ids uuid like the legacy Supabase ones.
// Better Auth is now the LIVE auth system (Step 3 cutover). BETTER_AUTH_SECRET
// is required by env.ts, so the only soft check left is the DB connection.
if (!env.DATABASE_URL) {
  console.warn('[auth] DATABASE_URL is not set — Better Auth cannot reach Neon.');
}

// Reuse a single pg Pool across `bun --hot` reloads — without this, each hot
// reload would leak a fresh Pool (and its connections). Stashing it on
// globalThis keeps one pool for the process lifetime.
const g = globalThis as unknown as { __maestroBetterAuthPool?: Pool };
const pool = (g.__maestroBetterAuthPool ??= new Pool({ connectionString: env.DATABASE_URL }));

export const auth = betterAuth({
  database: pool,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  // The SPA is served from a different origin than the API (e.g. :5173 → :3001
  // in dev; desk.maestro-desk.com → the API host in prod). Trust it so sign-in
  // and password-reset accept it. BETTER_AUTH_URL (the API's own origin) is
  // also trusted so the Maestro OAuth flow can land on the API-hosted
  // oauth-complete bridge (routes/maestro.ts) as its callbackURL.
  trustedOrigins: [env.APP_BASE_URL, env.BETTER_AUTH_URL],
  emailAndPassword: {
    enabled: true,
    // Emailed when a user requests (or is sent) a password reset — the only
    // way invited agents/owners set their first password (no password carried
    // over from Supabase). We bypass Better Auth's default reset URL and link
    // straight to the SPA with the token, so the SPA can collect the new
    // password and POST /api/auth/reset-password itself.
    sendResetPassword: async ({ user, token }) => {
      if (!isPostmarkConfigured()) {
        console.warn('[auth] sendResetPassword skipped — Postmark outbound not configured');
        return;
      }
      const link = `${env.APP_BASE_URL}/?reset_token=${encodeURIComponent(token)}`;
      await sendEmail({
        to: user.email,
        subject: 'Set your Maestro Desk password',
        textBody:
          `You've been invited to Maestro Desk.\n\n` +
          `Set your password using the link below (valid for 1 hour):\n${link}\n\n` +
          `If you weren't expecting this, you can ignore this email.`,
        fromEmail: env.POSTMARK_OUTBOUND_FROM,
        fromName: 'Maestro Desk',
      });
    },
  },
  plugins: [
    bearer(),
    // Maestro Connect as an OIDC provider. PKCE public-client flow; tokens are
    // stored in the `account` table so the API can later call the gateway on
    // the user's behalf (see lib/maestro.ts getUserAccessToken + getAccessToken).
    ...(maestroSignInEnabled
      ? [
          genericOAuth({
            config: [
              {
                providerId: MAESTRO_PROVIDER_ID,
                // Discovery lives at the canonical path (verified to return
                // issuer "https://auth.mert.md"); the `iss` claim is the bare
                // host, which Better Auth derives from the discovery doc.
                discoveryUrl: `${env.MAESTRO_ISSUER}/.well-known/openid-configuration`,
                clientId: env.MAESTRO_CLIENT_ID,
                clientSecret: env.MAESTRO_CLIENT_SECRET,
                scopes: MAESTRO_SCOPES,
                pkce: true,
                // The users table requires a non-null `name`, but a Maestro
                // profile may have name=null. Fall back to the email local-part
                // so the insert for a first-time agent never fails.
                mapProfileToUser: (profile: Record<string, unknown>) => {
                  const email = typeof profile.email === 'string' ? profile.email : '';
                  const rawName = typeof profile.name === 'string' ? profile.name.trim() : '';
                  const name = rawName || (email ? email.split('@')[0] : 'Maestro User');
                  return { email, name };
                },
              },
            ],
          }),
        ]
      : []),
  ],
  // Let a Maestro sign-in link to an existing Desk user with the same email —
  // this is how invited agents (created email-first during the cutover) start
  // signing in with Maestro without a duplicate account.
  //
  // SECURITY: listing Maestro in `trustedProviders` bypasses Better Auth's usual
  // requirement that the provider assert a verified email before auto-linking.
  // That is safe ONLY because Maestro Connect is the platform's identity source
  // of truth and verifies email ownership before issuing an identity, so a
  // Maestro token's email is already proven. If that invariant ever changes, a
  // token minted for an unverified email would become an account-takeover vector
  // (attacker claims a victim's email at Maestro → auto-links to the victim's
  // Desk account) — remove Maestro from `trustedProviders` then.
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: [MAESTRO_PROVIDER_ID],
      // `trustedProviders` only trusts the REMOTE (Maestro) email. Better Auth
      // independently requires the EXISTING LOCAL user's email to be verified
      // before it will link (requireLocalEmailVerified defaults to true) — and
      // invited agents are created email-first during the cutover and never
      // verify (email_verified = false), so without this they hit
      // `account_not_linked` on their first Maestro sign-in. We don't gate
      // linking on local verification: the operator created the account with a
      // known email and Maestro independently verifies the SAME address, so the
      // local flag adds no security here.
      requireLocalEmailVerified: false,
    },
  },
  user: {
    modelName: 'users',
    // Map Better Auth's camelCase fields onto our snake_case columns.
    fields: {
      emailVerified: 'email_verified',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
  advanced: {
    database: {
      // Defer id generation to the DB (`users.id` defaults to
      // gen_random_uuid()), so new users keep uuid ids.
      generateId: false,
    },
  },
});
