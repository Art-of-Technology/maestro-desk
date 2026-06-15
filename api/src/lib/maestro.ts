// Maestro Connect gateway client.
//
// One module, two callers — both hit the orchestrator at
// `${MAESTRO_GATEWAY_URL}/api/v1/proxy/...` with `Authorization: Bearer <token>`
// and (for player-visible data) an `X-Brand-Id` header:
//
//   1. UI / user-context  — the signed-in agent's Maestro OAuth access token
//      (stored by Better Auth's genericOAuth in the `account` table; fetched +
//      auto-refreshed via getUserAccessToken). The platform enforces THAT
//      user's brand permissions, so the Desk never has to.
//   2. Headless worker    — the long-lived `mh_live_*` API token from
//      MAESTRO_API_TOKEN (minted in the developer portal after approval). Used
//      by the email pipeline / AI drafting where there is no signed-in user.
//
// Identity model (see MAESTRO-AGENT.md §1): organizationId = tenant,
// brandId = a player-facing casino site (the X-Brand-Id), userId = the token.
// brand ids for the worker come from `maestro apps installations <appId>`.

import { auth, MAESTRO_PROVIDER_ID } from './auth.js';
import { env } from './env.js';

export class MaestroError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'MaestroError';
  }
}

/** True when the headless worker has credentials to call the gateway. */
export function workerMaestroConfigured(): boolean {
  return Boolean(env.MAESTRO_API_TOKEN);
}

interface FetchOpts {
  /** Bearer token: the user's Maestro access token, or the worker API token. */
  token: string;
  /** Player-visible (brand-scoped) endpoints require this — sent as X-Brand-Id. */
  brandId?: string | null;
  method?: string;
  body?: unknown;
  /** Query string params (undefined/null values are dropped). */
  query?: Record<string, string | number | null | undefined>;
}

/**
 * Low-level gateway call. `path` is the proxy path beginning with a slash,
 * e.g. "/api/v1/proxy/organizations". Returns the parsed JSON body; throws
 * MaestroError (carrying the upstream status + body) on any non-2xx.
 */
export async function maestroFetch<T = unknown>(path: string, opts: FetchOpts): Promise<T> {
  const url = new URL(`${env.MAESTRO_GATEWAY_URL}${path}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    Accept: 'application/json',
  };
  if (opts.brandId) headers['X-Brand-Id'] = opts.brandId;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (err) {
    throw new MaestroError(
      `Could not reach the Maestro gateway at ${env.MAESTRO_GATEWAY_URL}`,
      0,
      err instanceof Error ? err.message : String(err),
    );
  }

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    const msg =
      (parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : null) ?? `Maestro gateway returned HTTP ${res.status}`;
    throw new MaestroError(msg, res.status, parsed);
  }
  return parsed as T;
}

// ─── User-context (capability A — agent-triggered lookups) ──────────────────

/**
 * Fetch (and transparently refresh) the signed-in user's Maestro OAuth access
 * token from Better Auth's account store. Returns null if the user has no
 * linked Maestro account — i.e. they signed in some other way and we can't act
 * on their behalf against the gateway.
 */
export async function getUserAccessToken(userId: string, headers: Headers): Promise<string | null> {
  if (!maestroSignInPossible()) return null;
  try {
    const result = await auth.api.getAccessToken({
      body: { providerId: MAESTRO_PROVIDER_ID, userId },
      headers,
    });
    return result?.accessToken ?? null;
  } catch {
    // No linked Maestro account, or the refresh failed (e.g. revoked) — the
    // caller surfaces this as "reconnect your Maestro account".
    return null;
  }
}

function maestroSignInPossible(): boolean {
  return Boolean(env.MAESTRO_CLIENT_ID && env.MAESTRO_CLIENT_SECRET);
}

export interface MaestroOrganization {
  id: string;
  name: string;
  slug: string;
  industry?: string | null;
  userRole?: string | null;
  brandCounts?: number;
}

export interface MaestroBrand {
  id: string;
  name: string;
  slug?: string | null;
  organizationId?: string | null;
  logoUrl?: string | null;
  // The caller's role on this brand. The exact field is unconfirmed (this org
  // has no brands yet), so mapMaestroBrandRole checks the common spellings and
  // falls back to the org-level role.
  userRole?: string | null;
  role?: string | null;
  membershipRole?: string | null;
}

/**
 * Map the agent's Maestro role for a brand to a Desk role name. Brand- or
 * org-level admin/owner → "Admin"; everyone else → "Senior Agent". Per the
 * product decision, Desk permissions mirror Maestro's.
 */
export function mapMaestroBrandRole(brand: MaestroBrand, orgs: MaestroOrganization[]): string {
  const adminish = (v: unknown): boolean => typeof v === 'string' && /admin|owner/i.test(v);
  if (adminish(brand.userRole) || adminish(brand.role) || adminish(brand.membershipRole)) {
    return 'Admin';
  }
  const org = orgs.find((o) => o.id === brand.organizationId);
  if (org && adminish(org.userRole)) return 'Admin';
  return 'Senior Agent';
}

/** Organizations the signed-in user can access (scope organizations:read). */
export async function listUserOrganizations(token: string): Promise<MaestroOrganization[]> {
  const data = await maestroFetch<{ organizations?: MaestroOrganization[] }>(
    '/api/v1/proxy/organizations',
    { token },
  );
  return data.organizations ?? [];
}

/** Brands the signed-in user can access (scope brands:read). */
export async function listUserBrands(token: string): Promise<MaestroBrand[]> {
  const data = await maestroFetch<{ brands?: MaestroBrand[] }>('/api/v1/proxy/brands', { token });
  return data.brands ?? [];
}

// ─── Worker-context (capability B — headless email pipeline / AI drafting) ──

/**
 * Gateway call for the headless worker, using the app's API token. `brandId`
 * defaults to MAESTRO_BRAND_ID (the install's default brand) but callers can
 * override per-brand when the worker processes mail for multiple installs.
 */
export function workerFetch<T = unknown>(
  path: string,
  opts: { brandId?: string | null; query?: FetchOpts['query']; method?: string; body?: unknown } = {},
): Promise<T> {
  if (!env.MAESTRO_API_TOKEN) {
    throw new MaestroError('MAESTRO_API_TOKEN is not configured', 0);
  }
  return maestroFetch<T>(path, {
    token: env.MAESTRO_API_TOKEN,
    brandId: opts.brandId ?? (env.MAESTRO_BRAND_ID || null),
    query: opts.query,
    method: opts.method,
    body: opts.body,
  });
}
