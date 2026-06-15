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
  maestroFetch,
  MaestroError,
} from '../lib/maestro.js';
import { resolveBrandWorkspace } from '../lib/maestro-workspace.js';

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
    // Independent calls — fan out so the picker loads in one round-trip.
    const [organizations, brands] = await Promise.all([
      listUserOrganizations(token),
      listUserBrands(token),
    ]);
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
    const [brands, organizations] = await Promise.all([
      listUserBrands(token),
      listUserOrganizations(token),
    ]);
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
// The chosen brand rides in X-Brand-Id (set by the SPA after the brand pick).
// We call the gateway with the agent's own Maestro token so the platform
// enforces exactly the brands/players THEY may see.
maestro.get('/players', requireAuthOnly, async (c) => {
  ensureEnabled();
  const brandId = c.req.header('X-Brand-Id');
  if (!brandId) throw new HTTPException(400, { message: 'X-Brand-Id header required for player lookups.' });

  const token = await getUserAccessToken(c.get('userId'), c.req.raw.headers);
  if (!token) throw new HTTPException(409, { message: 'No linked Maestro account for this user.' });

  // Pass through the supported search params. The gateway resolves the player
  // resource for the brand; the exact member path is the platform's
  // members endpoint (scope members:read).
  try {
    const data = await maestroFetch('/api/v1/proxy/members', {
      token,
      brandId,
      query: {
        email: c.req.query('email'),
        username: c.req.query('username'),
        q: c.req.query('q'),
        limit: c.req.query('limit') ?? 20,
      },
    });
    return c.json(data);
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
