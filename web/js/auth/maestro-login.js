// "Sign in with Maestro" for the SPA (capability A).
//
// The OAuth dance itself is brokered server-side by Better Auth's genericOAuth
// plugin (PKCE) — see api/src/routes/maestro.ts. The browser flow is:
//
//   1. Click "Continue with Maestro" → top-level navigation to
//      `${API_BASE}/api/v1/maestro/login` (NOT a fetch — that keeps the PKCE
//      state cookie first-party on the API origin).
//   2. API 302s to auth.mert.md; agent signs in / consents.
//   3. auth.mert.md → API callback → API /oauth-complete bridge, which hands
//      the session back to us as `#maestro_session=<token>` on APP_BASE_URL.
//   4. handleMaestroRedirect() (called from app.js startup) reads that hash,
//      stashes the bearer, then auto-detects the workspace:
//        - fetch the agent's Maestro orgs + brands
//        - 1 brand  → select it automatically
//        - 2+ brands → show a picker
//      then routes into the Desk via the shared routeAfterAuth().

import { API_BASE, setJwt, setBrandId, apiGet, apiPost } from '../core/api-client.js';
import { rehydrateUser, signOut } from '../core/auth-client.js';
import { registerActions } from '../core/event-delegation.js';
import { routeAfterAuth, enterWorkspaceMembership } from './agent-login.js';

// Brands cached between auto-detect and a picker click.
let _brands = null;

function showError(msg) {
  const errEl = document.getElementById('login-error');
  if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
  const formEl = document.getElementById('login-form');
  const brandEl = document.getElementById('maestro-brand-picker');
  if (formEl) formEl.style.display = 'block';
  if (brandEl) brandEl.style.display = 'none';
}

function setBusy(msg) {
  const errEl = document.getElementById('login-error');
  if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; errEl.classList?.remove('auth-error'); }
}

// Kick off the flow (top-level navigation, so the API can set the PKCE cookie).
function startMaestroLogin() {
  window.location.assign(`${API_BASE}/api/v1/maestro/login`);
}

registerActions({
  'maestro.login':     () => startMaestroLogin(),
  'maestro.pickBrand': (ds) => pickBrand(ds),
});

/**
 * Reveal the "Continue with Maestro" button when the server has the provider
 * configured. Called once at startup. Silent on failure — the button just
 * stays hidden (e.g. the API is down or Maestro isn't wired on this box).
 */
export async function initMaestroButton() {
  try {
    const { enabled } = await apiGet('/api/v1/maestro/status', { auth: false, workspace: false });
    if (enabled) {
      const el = document.getElementById('maestro-signin');
      if (el) el.style.display = 'block';
    }
  } catch { /* leave the button hidden */ }
}

/**
 * If we've just landed back from the Maestro OAuth bridge, consume the session
 * token from the URL fragment and complete sign-in. Returns true when it
 * handled a Maestro redirect (so app.js startup can skip its other resumes).
 */
export async function handleMaestroRedirect() {
  const hash = window.location.hash || '';
  if (!hash.includes('maestro_session=') && !hash.includes('maestro_error=')) return false;

  const params = new URLSearchParams(hash.replace(/^#/, ''));
  // Strip the fragment immediately so the token never lingers in the URL/history.
  history.replaceState({}, '', window.location.pathname + window.location.search);

  const err = params.get('maestro_error');
  if (err) {
    showError(err === 'signin_failed'
      ? 'Maestro sign-in was cancelled or failed. Please try again.'
      : 'Could not complete Maestro sign-in. Please try again.');
    return true;
  }

  const token = params.get('maestro_session');
  if (!token) { showError('Maestro sign-in did not return a session.'); return true; }

  setJwt(token);
  setBusy('Signing in with Maestro…');
  try {
    await detectWorkspaceAndRoute();
  } catch (e) {
    signOut();
    showError(e?.message || 'Maestro sign-in failed.');
  }
  return true;
}

// Pending whoami payload, so the picker click can finish routing.
let _pendingMe = null;

// Maestro brands ARE the workspace: detect the agent's brands, then enter the
// brand's Desk workspace (auto-provisioned + membership granted server-side).
async function detectWorkspaceAndRoute() {
  const me = await rehydrateUser();           // GET /whoami with the new bearer
  if (!me) throw new Error('Could not load your account after Maestro sign-in.');
  _pendingMe = me;

  // Platform admins (God) land in the platform view — brands are an agent
  // concept, so we don't run brand selection for them.
  if (me.user?.is_platform_admin) { routeAfterAuth(me); return; }

  let brands = [];
  try {
    const ws = await apiGet('/api/v1/maestro/workspace', { workspace: false });
    brands = ws.brands || [];
  } catch (e) {
    signOut();
    throw new Error(e?.message || 'Could not load your Maestro brands.');
  }

  if (brands.length === 0) {
    signOut();
    showError('Your Maestro account has no brand access yet — ask your operator to grant a brand.');
    return;
  }
  if (brands.length === 1) { await selectBrand(brands[0]); return; }
  _brands = brands;
  renderBrandPicker(brands, me);
}

// Enter the brand's workspace: the server find-or-provisions it and grants the
// agent membership (role mapped from their Maestro role), returning a
// membership shaped like a /whoami entry that enterWorkspaceMembership boots.
async function selectBrand(brand) {
  setBusy(`Entering ${brand.name}…`);
  let membership;
  try {
    ({ membership } = await apiPost('/api/v1/maestro/select-brand', { brandId: brand.id }, { workspace: false }));
  } catch (e) {
    showError(e?.message || `Could not open ${brand.name}.`);
    return;
  }
  setBrandId(brand.id);   // X-Brand-Id for this agent's player lookups
  await enterWorkspaceMembership(_pendingMe.user, membership);
}

function renderBrandPicker(brands, me) {
  _pendingMe = me;
  const formEl = document.getElementById('login-form');
  const signinEl = document.getElementById('maestro-signin');
  const pickEl = document.getElementById('maestro-brand-picker');
  const errEl = document.getElementById('login-error');
  if (errEl) errEl.style.display = 'none';
  if (formEl) formEl.style.display = 'none';
  if (signinEl) signinEl.style.display = 'none';
  if (!pickEl) return;
  pickEl.style.display = 'block';
  pickEl.innerHTML = `
    <div class="auth-sub" style="margin:8px 0 14px;text-align:center">Choose a brand to work in.</div>
    <div class="auth-accounts" style="margin-top:0;border-top:none;padding-top:0">
      ${brands.map((b, i) => `
        <div class="auth-account" data-action="maestro.pickBrand" data-idx="${i}">
          <div class="auth-account-av">${escInitials(b.name)}</div>
          <div>
            <div class="auth-account-name">${escText(b.name)}</div>
            <div class="auth-account-role">${escText(b.slug || 'Brand')}</div>
          </div>
        </div>
      `).join('')}
    </div>`;
}

function pickBrand(ds) {
  const i = parseInt(ds.idx, 10);
  if (!_brands || isNaN(i) || !_brands[i]) return;
  selectBrand(_brands[i]);
}

function escInitials(name) {
  return escText((name || '?').split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?');
}

function escText(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[ch]));
}
