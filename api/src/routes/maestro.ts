import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { auth, maestroSignInEnabled, MAESTRO_PROVIDER_ID } from '../lib/auth.js';
import { requireAuthOnly } from '../middleware/auth.js';
import { env } from '../lib/env.js';
import { captureException } from '../lib/instrument.js';
import { sendOpsAlert } from '../lib/alert.js';
import {
  getUserAccessToken,
  listUserOrganizations,
  listUserBrands,
  mapMaestroBrandRole,
  workerFetch,
  workerMaestroConfigured,
  MaestroError,
} from '../lib/maestro.js';
import { resolveBrandWorkspace, agentBrandWorkspaceId } from '../lib/maestro-workspace.js';
import { summarizePlayerAccess } from '../lib/player-audit.js';
import { writeAudit } from '../middleware/platform-admin.js';

// Maestro Connect integration routes.
//
//   GET /login            → kick off "Sign in with Maestro" (browser navigates
//                           here; we 302 to the Maestro authorize URL with PKCE)
//   GET /oauth-complete   → OAuth callbackURL bridge: turns the first-party API
//                           session cookie into a bearer token and hands it to
//                           the SPA via a URL fragment (the SPA is bearer-based,
//                           not cookie-based, so we don't rely on cross-origin
//                           cookies anywhere)
//   GET /workspace        → orgs + brands the signed-in agent can access, for
//                           the post-login auto-detect / brand picker
//   GET /players          → player lookup proxied with the agent's Maestro
//                           token + X-Brand-Id (the platform enforces their
//                           brand permissions)
export const maestro = new Hono();

// SPA origin we hand the session back to. APP_BASE_URL is the canonical SPA
// origin (trusted by Better Auth); we only ever redirect to it, never to a
// caller-supplied URL, so the token can't be exfiltrated to another origin.
const SPA_ORIGIN = env.APP_BASE_URL; // trailing slash already stripped in env.ts
const OAUTH_COMPLETE_URL = `${env.BETTER_AUTH_URL}/api/v1/maestro/oauth-complete`;
const OAUTH_ERROR_URL = `${env.BETTER_AUTH_URL}/api/v1/maestro/oauth-error`;

// The sign-in flow is top-level browser navigation, so an error status renders
// as a raw error page (Cloudflare replaces an origin 502 with its own "Host
// Error" screen — seen during the mert.md platform outages). Failures land the
// user back on the login screen instead, while keeping app.onError's
// observability (Sentry + the deduped ops alert). The redirect target is the
// fixed SPA_ORIGIN constant, never caller input.
function reportAndRedirect(c: Context, err: unknown, code: 'unavailable' | 'signin_failed') {
  // Reporting is best-effort and must neither delay nor lose the redirect: the
  // alert write is fire-and-forget (persistent Node process — no serverless
  // freeze to outrun, unlike app.onError's await) and any reporting failure is
  // swallowed so it can't escape to app.onError as a raw 500.
  try {
    captureException(err, { path: c.req.path, method: c.req.method });
    console.error(`${c.req.path} failed:`, err);
    const name = err instanceof Error ? err.constructor.name : 'Error';
    void sendOpsAlert({
      signature: `api-error:${c.req.method}:${c.req.path}:${name}`,
      severity: 'critical',
      title: `Maestro sign-in failure: ${name} at ${c.req.method} ${c.req.path}`,
      detail: `${name}: ${err instanceof Error ? err.message : String(err)}`,
    }).catch(() => {});
  } catch { /* never trade the user's redirect for telemetry */ }
  return c.redirect(`${SPA_ORIGIN}/#maestro_error=${code}`);
}

function ensureEnabled() {
  if (!maestroSignInEnabled) {
    throw new HTTPException(503, {
      message: 'Sign in with Maestro is not configured on this server.',
    });
  }
}

// ─── Status (unauthenticated) ────────────────────────────────────────────────
// The SPA calls this on the login screen to decide whether to show the
// "Continue with Maestro" button — hidden on a dev box with no Maestro creds.
maestro.get('/status', (c) => c.json({ enabled: maestroSignInEnabled }));

// ─── Sign-in initiation (top-level browser navigation) ───────────────────────
// Done server-side (not a SPA fetch) so the PKCE state cookie Better Auth sets
// is stored first-party on the API origin — the callback on the same origin can
// then read it. A cross-origin fetch would drop that cookie and break PKCE.
maestro.get('/login', async (c) => {
  try {
    ensureEnabled();
    const baResp = await auth.api.signInWithOAuth2({
      body: {
        providerId: MAESTRO_PROVIDER_ID,
        callbackURL: OAUTH_COMPLETE_URL,
        errorCallbackURL: OAUTH_ERROR_URL,
      },
      asResponse: true,
    });
    const data = (await baResp.json().catch(() => null)) as { url?: string } | null;
    if (!data?.url) {
      // Better Auth answers with a 400 Response (not a throw) when OIDC
      // discovery comes back empty — the signature of a Maestro platform outage.
      throw new Error(`Maestro did not return an authorization URL (upstream status ${baResp.status}).`);
    }
    // Propagate Better Auth's Set-Cookie (the PKCE state) onto our 302 so the
    // browser stores it before following the redirect to auth.mert.md.
    const headers = new Headers({ Location: data.url });
    for (const cookie of baResp.headers.getSetCookie?.() ?? []) {
      headers.append('set-cookie', cookie);
    }
    return new Response(null, { status: 302, headers });
  } catch (err) {
    // Deliberate HTTP errors keep their status — ensureEnabled's 503 means a
    // permanent server misconfiguration, not "try again in a few minutes".
    if (err instanceof HTTPException) throw err;
    return reportAndRedirect(c, err, 'unavailable');
  }
});

// Better Auth sends the browser here (with ?error=…) when the OAuth dance
// fails mid-flight — e.g. Maestro dies between authorize and token exchange,
// or the agent cancels consent. User cancels land here too, so this logs
// without alerting.
maestro.get('/oauth-error', (c) => {
  console.warn('maestro/oauth-error:', c.req.query('error') ?? 'unknown');
  return c.redirect(`${SPA_ORIGIN}/#maestro_error=signin_failed`);
});

// ─── Callback bridge: first-party session cookie → SPA bearer token ──────────
maestro.get('/oauth-complete', async (c) => {
  try {
    // Confirm the OAuth dance actually established a session on this origin.
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) {
      return c.redirect(`${SPA_ORIGIN}/#maestro_error=signin_failed`);
    }
    // The bearer token the SPA needs IS the signed session-cookie value (that's
    // exactly what Better Auth's bearer plugin accepts). Pull it from the Cookie
    // header by suffix so we're agnostic to the cookie prefix (`__Secure-` in
    // prod, bare in dev).
    const token = readSessionCookie(c.req.header('cookie'));
    if (!token) {
      return c.redirect(`${SPA_ORIGIN}/#maestro_error=no_session`);
    }
    // Fragment, not query: the token never hits a server log or Referer header.
    // The SPA reads location.hash, stashes the bearer, and clears the hash.
    return c.redirect(`${SPA_ORIGIN}/#maestro_session=${encodeURIComponent(token)}`);
  } catch (err) {
    // Same top-level-navigation concern as /login: a getSession failure (e.g.
    // a DB blip) must not surface as a raw error page mid sign-in.
    return reportAndRedirect(c, err, 'signin_failed');
  }
});

function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name.endsWith('session_token')) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

// ─── Post-login workspace auto-detect (orgs + brands) ────────────────────────
maestro.get('/workspace', requireAuthOnly, async (c) => {
  ensureEnabled();
  const token = await getUserAccessToken(c.get('userId'), c.req.raw.headers);
  if (!token) {
    // Signed in, but no linked Maestro account (e.g. email/password user) — the
    // SPA treats this as "this account isn't connected to Maestro".
    throw new HTTPException(409, { message: 'No linked Maestro account for this user.' });
  }
  try {
    // Brands are listed per-org, so fetch the org list first and reuse it for
    // the brand fan-out (listUserBrands(token, organizations)).
    const organizations = await listUserOrganizations(token);
    const brands = await listUserBrands(token, organizations);
    return c.json({ organizations, brands });
  } catch (err) {
    throw toHttp(err);
  }
});

// ─── Brand selection → enter the brand's workspace ───────────────────────────
// Maestro brands ARE the canonical workspace. Picking a brand find-or-provisions
// its Desk workspace and auto-grants the agent membership (role mapped from
// their Maestro role). We re-fetch the agent's brands server-side and require
// the chosen brand to be in that list, so the client can't enter a brand the
// platform wouldn't grant them.
maestro.post('/select-brand', requireAuthOnly, async (c) => {
  ensureEnabled();
  const body = (await c.req.json().catch(() => null)) as { brandId?: unknown } | null;
  const brandId = typeof body?.brandId === 'string' ? body.brandId : null;
  if (!brandId) throw new HTTPException(400, { message: 'brandId is required.' });

  const userId = c.get('userId');
  const token = await getUserAccessToken(userId, c.req.raw.headers);
  if (!token) throw new HTTPException(409, { message: 'No linked Maestro account for this user.' });

  let brand;
  let orgs;
  try {
    const organizations = await listUserOrganizations(token);
    const brands = await listUserBrands(token, organizations);
    brand = brands.find((b) => b.id === brandId);
    orgs = organizations;
  } catch (err) {
    throw toHttp(err);
  }
  if (!brand) throw new HTTPException(403, { message: 'You do not have access to that brand.' });

  const roleName = mapMaestroBrandRole(brand, orgs);
  const membership = await resolveBrandWorkspace(userId, brand, roleName);
  // The agent still holds the brand at Maestro, but an admin may have deactivated
  // their Desk membership. requireAuth would 403 every subsequent call anyway;
  // reject up front so the brand pick doesn't appear to succeed.
  if (!membership.active) {
    throw new HTTPException(403, { message: 'Your access to this brand has been deactivated.' });
  }
  return c.json({ membership, brand: { id: brand.id, name: brand.name } });
});

// ─── Player lookup (agent-triggered, brand-scoped) ───────────────────────────
// Lookup is by ONE exact key — email (which also matches username), numeric
// member id, or Maestro user id — and returns a single member overview
// (profile + balance). This is NOT a paginated browse/search by partial name;
// the platform exposes that as a separate endpoint we haven't wired.
//
// The chosen brand rides in X-Brand-Id (set by the SPA after the brand pick).
// We call the platform member-lookup with the APP token (mh_live_*, scope
// members:read — see lib/maestro.ts workerFetch), NOT the agent's OAuth token:
// that's the platform's documented contract for this endpoint, and it means an
// agent who hasn't personally linked Maestro can still look a player up. Access
// is gated by the agent's brand workspace, not per-user platform perms.
maestro.get('/players', requireAuthOnly, async (c) => {
  ensureEnabled();
  if (!workerMaestroConfigured()) {
    throw new HTTPException(503, { message: 'Player lookup is not configured (no Maestro API token).' });
  }
  const brandId = c.req.header('X-Brand-Id');
  if (!brandId) throw new HTTPException(400, { message: 'X-Brand-Id header required for player lookups.' });

  // The gateway call uses the app token (broad members:read), so enforce that
  // THIS agent is actually a member of the brand's workspace before looking
  // anyone up — otherwise an agent could read any installed brand's players.
  // The workspace id doubles as the audit row's tenant below.
  const userId = c.get('userId');
  const workspaceId = await agentBrandWorkspaceId(userId, brandId);
  if (!workspaceId) {
    throw new HTTPException(403, { message: 'You do not have access to this brand.' });
  }

  // Exactly one key. `email` is forwarded as-is (the gateway accepts an email
  // OR a username on that param); numeric member id and Maestro id are distinct.
  const email = c.req.query('email');
  const memberId = c.req.query('memberId');
  const maestroUserId = c.req.query('maestroUserId');
  const key = email ? { email } : memberId ? { memberId } : maestroUserId ? { maestroUserId } : null;
  if (!key) throw new HTTPException(400, { message: 'Provide one of email, memberId or maestroUserId.' });

  try {
    const member = await workerFetch<Record<string, unknown>>('/api/v1/proxy/member/lookup', {
      brandId,
      query: key,
    });
    // The gateway answers HTTP 200 with { success:false, errorCode:101 } when no
    // member matches — surface that as a clean 404 the SPA can show as "not found".
    if (!member || member.success === false || member.errorCode === 101) {
      return c.json({ found: false }, 404);
    }
    // Read-access audit: record WHO viewed WHICH player's sensitive data (the
    // "who looked at this account" trail regulators expect). Logs the stable
    // player id + the categories exposed (balance/kyc/…) — never the values.
    // Fall back to the looked-up value so the audit row always names a subject,
    // even if the gateway record lacks userId/memberId.
    const access = summarizePlayerAccess(member, Object.values(key)[0]);
    // writeAudit swallows its own errors (logs, never throws) — a failed audit
    // write can't abort the lookup; awaiting it just ensures the row is durably
    // persisted before we respond (serverless can freeze after return).
    await writeAudit({
      workspaceId,
      actorUserId: userId,
      action: 'player.viewed',
      targetType: 'player',
      targetId: access.playerId,
      metadata: { brand_id: brandId, lookup_key: Object.keys(key)[0], accessed: access.accessed },
    });
    return c.json({ found: true, member });
  } catch (err) {
    throw toHttp(err);
  }
});

function toHttp(err: unknown): HTTPException {
  if (err instanceof MaestroError) {
    // 0 = couldn't reach the gateway; surface as 502. Otherwise mirror the
    // upstream status (403 = the agent lacks that brand/scope, etc.).
    const status = err.status === 0 ? 502 : err.status;
    return new HTTPException(status as 400, { message: err.message });
  }
  return new HTTPException(500, { message: 'Unexpected error calling Maestro.' });
}
