// Better Auth–backed auth for the SPA.
//
// Two callers:
//   - js/auth/platform-admin.js — platform admins (no workspace context)
//   - js/auth/agent-login.js    — agents signing into a specific workspace
//
// Both end up at /api/v1/whoami, which returns the user record plus the
// list of workspace memberships. The platform-admin path ignores
// memberships and shows the god panel; the agent path uses memberships to
// auto-pick the workspace (1 → auto) or surface a picker (2+).
//
// Sign-in posts to Better Auth's /api/auth/sign-in/email; with the bearer
// plugin the session token comes back in the `set-auth-token` response header
// (exposed cross-origin), which we stash as the bearer for every API call.
//
// Storage:
//   sessionStorage.maestro_jwt          — handled by api-client
//   sessionStorage.maestro_workspace_id — handled by api-client
//   sessionStorage.maestro_user         — JSON of the current user (here)

import { apiGet, setJwt, setWorkspaceId, getJwt, JWT_KEY, API_BASE } from './api-client.js';

const USER_KEY = 'maestro_user';

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
 * Generic email/password sign-in via Supabase Auth. Stashes the JWT, then
 * calls /api/v1/whoami to load the user + memberships. Returns the whoami
 * payload: { user, memberships }.
 *
 * Note: this does NOT pick a workspace. Callers decide what to do with the
 * memberships list (auto-pick if length 1, render a picker if more, treat
 * as god-only if empty).
 */
export async function signIn(email, password) {
  const res = await fetch(`${API_BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.message || body.error?.message || `Sign-in failed (HTTP ${res.status})`);
  }
  // Bearer plugin returns the session token in this response header.
  const token = res.headers.get('set-auth-token');
  if (!token) {
    throw new Error('Sign-in succeeded but no session token was returned');
  }
  setJwt(token);
  const me = await apiGet('/api/v1/whoami', { workspace: false });
  setCurrentUser(me.user);
  return me;
}

/**
 * Set a new password from an emailed reset link. `token` comes from the
 * `reset_token` query param on the link Better Auth sent. On success the
 * caller should send the user to sign in with their new password.
 */
export async function resetPassword(token, newPassword) {
  const res = await fetch(`${API_BASE}/api/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, newPassword }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status === false) {
    throw new Error(body.message || body.error?.message || `Could not set password (HTTP ${res.status})`);
  }
  return true;
}

/**
 * Request a password-reset email (the self-serve "forgot password" flow).
 * Posts to Better Auth's request-password-reset, which is enumeration-safe
 * (always 200 whether or not the email exists) — so we only surface genuine
 * server/network failures; the caller shows a neutral "if it exists…" confirm.
 */
export async function requestPasswordReset(email) {
  const res = await fetch(`${API_BASE}/api/auth/request-password-reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (res.status >= 500) {
    throw new Error('Could not send the reset link — please try again.');
  }
  return true;
}

/**
 * Platform-admin sign-in — thin wrapper that returns just the user (matches
 * the existing call sites in js/auth/platform-admin.js).
 */
export async function platformAdminSignIn(email, password) {
  const { user } = await signIn(email, password);
  return user;
}

/**
 * Bootstrap helper for page reload — if a JWT is in sessionStorage, refresh
 * the user + memberships from /whoami. Returns { user, memberships } on
 * success, null if the stored token is invalid (and clears the stale state).
 */
export async function rehydrateUser() {
  if (!sessionStorage.getItem(JWT_KEY)) return null;
  try {
    const me = await apiGet('/api/v1/whoami', { workspace: false });
    setCurrentUser(me.user);
    return me;
  } catch (err) {
    if (err.status === 401) signOut();
    return null;
  }
}

export function signOut() {
  // Best-effort server-side session revocation — fire-and-forget so the local
  // state is cleared immediately regardless of the network call.
  const jwt = getJwt();
  if (jwt) {
    fetch(`${API_BASE}/api/auth/sign-out`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
    }).catch(() => {});
  }
  setJwt(null);
  setWorkspaceId(null);
  setCurrentUser(null);
}

export function isPlatformAdmin() {
  return Boolean(getCurrentUser()?.is_platform_admin);
}
