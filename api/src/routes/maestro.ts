import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { auth, maestroSignInEnabled, MAESTRO_PROVIDER_ID } from '../lib/auth.js';
import { requireAuthOnly } from '../middleware/auth.js';
import { env } from '../lib/env.js';
import {
  getUserAccessToken,
  listUserOrganizations,
  listUserBrands,
  mapMaestroBrandRole,
  workerFetch,
  workerMaestroConfigured,
  MaestroError,
} from '../lib/maestro.js';
import { resolveBrandWorkspace, agentCanAccessBrand } from '../lib/maestro-workspace.js';

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
const SPA_ORIGIN = env.APP_BASE_URL.replace(/\/+$/, '');
const OAUTH_COMPLETE_URL = `${env.BETTER_AUTH_URL.replace(/\/+$/, '')}/api/v1/maestro/oauth-complete`;

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
  ensureEnabled();
  const baResp = await auth.api.signInWithOAuth2({
    body: { providerId: MAESTRO_PROVIDER_ID, callbackURL: OAUTH_COMPLETE_URL },
    asResponse: true,
  });
  const data = (await baResp.clone().json().catch(() => null)) as { url?: string } | null;
  if (!data?.url) {
    throw new HTTPException(502, { message: 'Maestro did not return an authorization URL.' });
  }
  // Propagate Better Auth's Set-Cookie (the PKCE state) onto our 302 so the
  // browser stores it before following the redirect to auth.mert.md.
  const headers = new Headers({ Location: data.url });
  for (const cookie of baResp.headers.getSetCookie?.() ?? []) {
    headers.append('set-cookie', cookie);
  }
  return new Response(null, { status: 302, headers });
});

// ─── Callback bridge: first-party session cookie → SPA bearer token ──────────
maestro.get('/oauth-complete', async (c) => {
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
  if (!(await agentCanAccessBrand(c.get('userId'), brandId))) {
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
