// Real Supabase-backed auth for platform admins.
//
// The existing demo-persona login in js/auth/index.js stays untouched —
// that's still the entry point for the agent demo. This module is the
// real-auth path used by the god panel: sign in against Supabase's
// /auth/v1/token endpoint, store the JWT, load /whoami to identify the
// user + their is_platform_admin flag.
//
// We don't ship the supabase-js SDK — the auth flow is a single REST call,
// so a direct fetch is enough and avoids a CDN dependency / build step.
//
// Storage:
//   sessionStorage.maestro_jwt   — handled by api-client
//   sessionStorage.maestro_user  — JSON of the current user

import { apiGet, apiPost, apiCall, setJwt, JWT_KEY } from './api-client.js';

const USER_KEY = 'maestro_user';

let _config = null;          // cached /config response

export async function loadConfig() {
  if (_config) return _config;
  _config = await apiGet('/api/v1/config', { auth: false });
  return _config;
}

export function getCurrentUser() {
  const raw = sessionStorage.getItem(USER_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { return null; }
}

function setCurrentUser(user) {
  if (user) sessionStorage.setItem(USER_KEY, JSON.stringify(user));
  else      sessionStorage.removeItem(USER_KEY);
}

/**
 * Email/password sign-in via Supabase Auth. Throws on bad credentials or
 * network failure. On success, stashes the JWT + the user (loaded from
 * /whoami) and returns the user.
 *
 * The caller is responsible for the UI transition (hide auth screen, show
 * app, etc.) — this function is auth-only, no DOM side effects.
 */
export async function platformAdminSignIn(email, password) {
  const cfg = await loadConfig();
  const res = await fetch(`${cfg.supabase_url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: cfg.supabase_anon_key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error_description || body.msg || `Sign-in failed (HTTP ${res.status})`);
  }
  if (!body.access_token) {
    throw new Error('Sign-in succeeded but no token returned');
  }
  setJwt(body.access_token);
  // Confirm the token works AND fetch the user record. /whoami also reveals
  // is_platform_admin so the caller can decide whether to surface the god UI.
  const me = await apiGet('/api/v1/whoami');
  setCurrentUser(me.user);
  return me.user;
}

/**
 * Bootstrap helper for page reload — if a JWT is in sessionStorage, refresh
 * the user record from /whoami. Returns the user on success, null if the
 * stored token is invalid (and clears the stale token).
 */
export async function rehydrateUser() {
  if (!sessionStorage.getItem(JWT_KEY)) return null;
  try {
    const me = await apiGet('/api/v1/whoami');
    setCurrentUser(me.user);
    return me.user;
  } catch (err) {
    // 401 → token expired/invalid. Clear it so the SPA falls back to auth screen.
    if (err.status === 401) {
      signOut();
    }
    return null;
  }
}

export function signOut() {
  setJwt(null);
  setCurrentUser(null);
}

export function isPlatformAdmin() {
  return Boolean(getCurrentUser()?.is_platform_admin);
}
