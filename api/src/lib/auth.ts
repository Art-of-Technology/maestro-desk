import { safeError } from './diagnostics.js';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { bearer } from 'better-auth/plugins';
import { maestroOAuth, MAESTRO_PROVIDER_ID } from './maestro-oidc.js';
import { Pool } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { TransactionSql } from 'postgres';
import { env, isVercelPreview, PREVIEW_SPA_ORIGIN_RE } from './env.js';
import { sendEmail, isPostmarkConfigured } from './postmark-outbound.js';
import { getDb } from './db.js';

// "Sign in with Maestro" (Maestro Connect OIDC). Only mounted when the app's
// OAuth client credentials are configured — when they're absent (e.g. a dev
// box that hasn't wired Maestro yet) the provider simply isn't registered and
// the SPA hides the button. Compliant with the "Better Auth only" guardrail:
// Maestro is an OIDC *provider* feeding Better Auth, not a separate auth system.
export { MAESTRO_PROVIDER_ID };
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

const SESSION_SECONDS = 8 * 60 * 60;
const invitationDelivery = new AsyncLocalStorage<{ sent: boolean }>();

// Better Auth deliberately hides reset-mail failures from its public endpoint.
// Administrator invitations need the actual result, isolated per request.
export async function sendInvitationSetup(email: string): Promise<boolean> {
  return invitationDelivery.run({ sent: false }, async () => {
    await auth.api.requestPasswordReset({ body: { email } });
    return invitationDelivery.getStore()!.sent;
  });
}

async function activatePendingInvitations(userId: string, sql: ReturnType<typeof getDb> | TransactionSql = getDb()) {
  await sql`update workspace_members
    set active = true, invitation_pending = false
    where user_id = ${userId} and invitation_pending = true
      and exists(select 1 from users where id = ${userId} and email_verified = true and deleted_at is null)`;
}

export const auth = betterAuth({
  logger: {
    log(level, _message, ...args) {
      if (level === 'error' || level === 'warn') {
        console[level]('[auth] authentication diagnostic', safeError(args.find(arg => arg instanceof Error)));
      }
    },
  },
  session: { expiresIn: SESSION_SECONDS, disableSessionRefresh: true },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      // Only server-side administrator invitation flows may create local users.
      if (ctx.path === '/sign-up/email' && ctx.request) {
        throw new APIError('FORBIDDEN', { message: 'Ask your administrator for an invitation.' });
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      // Password knowledge alone cannot activate a pre-registered address.
      // The database check also excludes deleted and unverified accounts.
      if (ctx.path === '/sign-in/email' && ctx.context.newSession) {
        await activatePendingInvitations(ctx.context.newSession.user.id);
      }
    }),
  },
  databaseHooks: {
    session: {
      create: {
        // Better Auth otherwise gives rememberMe:false a fixed 24-hour lifetime.
        before: async (session) => ({ data: { ...session, expiresAt: new Date(Math.min(
          session.expiresAt.getTime(), session.createdAt.getTime() + SESSION_SECONDS * 1000,
        )) } }),
      },
    },
  },
  database: pool,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  // The SPA is served from a different origin than the API (e.g. :5173 → :3001
  // in dev; app.respovia.com → the API host in prod). Trust it so sign-in
  // and password-reset accept it. BETTER_AUTH_URL (the API's own origin) is
  // also trusted so the Maestro OAuth flow can land on the API-hosted
  // oauth-complete bridge (routes/maestro.ts) as its callbackURL.
  // On preview deployments (staging) additionally trust the requesting PR-preview
  // SPA origin so login POSTs from a preview link aren't rejected. We reflect the
  // request's own Origin only when it passes the SAME regex the CORS layer uses
  // (PREVIEW_SPA_ORIGIN_RE) — the function form keeps the two layers on one exact
  // pattern rather than a looser wildcard string that could drift or over-match
  // (trustedOrigins also gates callbackURL/redirect targets, so a broader match
  // here would be an open-redirect surface). Never widened in production.
  trustedOrigins: (request?: Request) => {
    const base = [env.APP_BASE_URL, env.BETTER_AUTH_URL];
    if (!isVercelPreview) return base;
    const origin = request?.headers.get('origin');
    return origin && PREVIEW_SPA_ORIGIN_RE.test(origin) ? [...base, origin] : base;
  },
  emailAndPassword: {
    enabled: true,
    onPasswordReset: async ({ user }) => {
      // A consumed, emailed reset token proves mailbox ownership and replaces
      // any password chosen before the legitimate owner accepted an invite.
      // Revoke sessions before making pending access available, atomically.
      await getDb().begin(async (sql) => {
        await sql`delete from "session" where "userId" = ${user.id}`;
        await sql`update users set email_verified = true
          where id = ${user.id} and email = ${user.email} and deleted_at is null`;
        await activatePendingInvitations(user.id, sql);
      });
    },
    // Preserve existing agents' sign-in while requiring mailbox verification
    // for new invitation activation and account linking.
    minPasswordLength: 12,
    // Emailed when a user requests (or is sent) a password reset — the only
    // way invited agents/owners set their first password (no password carried
    // over from Supabase). We bypass Better Auth's default reset URL and link
    // straight to the SPA with the token, so the SPA can collect the new
    // password and POST /api/auth/reset-password itself.
    sendResetPassword: async ({ user, token }) => {
      if (!isPostmarkConfigured()) {
        throw new APIError('SERVICE_UNAVAILABLE', { message: 'Password email is currently unavailable.' });
      }
      const link = `${env.APP_BASE_URL}/?reset_token=${encodeURIComponent(token)}`;
      await sendEmail({
        to: user.email,
        subject: 'Set your Respovia password',
        textBody:
          `You've been invited to Respovia.\n\n` +
          `Set your password using the link below (valid for 1 hour):\n${link}\n\n` +
          `Use this link to confirm your email address and set your password before joining an invited workspace.\n\n` +
          `If you weren't expecting this, you can ignore this email.`,
        fromEmail: env.POSTMARK_OUTBOUND_FROM,
        fromName: 'Respovia',
      });
      const delivery = invitationDelivery.getStore();
      if (delivery) delivery.sent = true;
    },
  },
  plugins: [
    bearer(),
    // Maestro Connect as an OIDC provider. Authorization code + PKCE; tokens are
    // stored in the `account` table so the API can later call the gateway on
    // the user's behalf (see lib/maestro.ts getUserAccessToken + getAccessToken).
    ...(maestroSignInEnabled
      ? [
          maestroOAuth({
            issuer: env.MAESTRO_ISSUER,
            clientId: env.MAESTRO_CLIENT_ID,
            clientSecret: env.MAESTRO_CLIENT_SECRET,
            scopes: MAESTRO_SCOPES,
          }),
        ]
      : []),
  ],
  // Linking requires verified email on BOTH identities. Invited local users
  // first complete the emailed password setup, which also revokes old sessions.
  // Already-linked accounts continue to use their provider subject identifier.
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: [],
      requireLocalEmailVerified: true,
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
