// Generic API client for the Maestro Desk backend.
//
// Wraps fetch() with:
//   - automatic Bearer-token header from sessionStorage
//   - JSON encode/decode on request + response
//   - error normalisation (ApiError with status + body)
//
// API base defaults to http://localhost:3001 for local dev. In production
// (or any other deployment), set `window.MAESTRO_API_BASE` in index.html
// BEFORE this module is imported, and we'll pick it up.
//
// Token lives in sessionStorage under JWT_KEY — survives a tab refresh,
// gone when the tab closes. Use signOut() in auth-client to clear it.

export const API_BASE = (typeof window !== 'undefined' && window.MAESTRO_API_BASE) || 'http://localhost:3001';
export const JWT_KEY  = 'maestro_jwt';

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function getJwt() {
  return sessionStorage.getItem(JWT_KEY);
}

export function setJwt(jwt) {
  if (jwt) sessionStorage.setItem(JWT_KEY, jwt);
  else     sessionStorage.removeItem(JWT_KEY);
}

/**
 * Low-level call. path is "/api/v1/..."; method defaults to GET; body is
 * JSON-encoded automatically. Throws ApiError on non-2xx.
 *
 * { auth: false } skips the Authorization header (for /config + /health).
 */
export async function apiCall(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const jwt = getJwt();
    if (jwt) headers.Authorization = `Bearer ${jwt}`;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; }
  catch { parsed = text; }
  if (!res.ok) {
    const msg = (parsed && parsed.error) || res.statusText || `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, parsed);
  }
  return parsed;
}

export const apiGet    = (path, opts)        => apiCall(path, { ...opts, method: 'GET' });
export const apiPost   = (path, body, opts)  => apiCall(path, { ...opts, method: 'POST', body });
export const apiPatch  = (path, body, opts)  => apiCall(path, { ...opts, method: 'PATCH', body });
export const apiDelete = (path, opts)        => apiCall(path, { ...opts, method: 'DELETE' });
