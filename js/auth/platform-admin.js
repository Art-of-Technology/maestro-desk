// Real-auth sign-in flow for platform admins.
//
// The existing js/auth/index.js login flow is purely cosmetic — it transitions
// into the app shell with one of the demo personas. This module is the
// production sign-in path: real Supabase JWT, real user record, real
// is_platform_admin check.
//
// Surface:
//   - showPlatformAdminLogin()   — swap the auth screen to the platform panel
//   - submitPlatformAdminLogin() — handle the form submit
//   - revealGodNav()             — show the god nav entry on successful auth
//
// Why a separate panel rather than swapping submitLogin: the demo persona
// flow is wired to inline onclick handlers and doesn't talk to the API at
// all. Mixing real auth in would either break the demo or layer real-auth
// fallbacks on every fake login.

import { nav } from '../core/router.js';
import { platformAdminSignIn, rehydrateUser, signOut, isPlatformAdmin } from '../core/auth-client.js';
import { showAuthPanel } from './index.js';
import { registerActions } from '../core/event-delegation.js';

function showPlatformAdminLogin() {
  showAuthPanel('platform-admin');
  const errEl = document.getElementById('pa-error');
  if (errEl) errEl.style.display = 'none';
}

async function submitPlatformAdminLogin() {
  const email = document.getElementById('pa-email')?.value.trim() || '';
  const pw    = document.getElementById('pa-password')?.value || '';
  const errEl = document.getElementById('pa-error');
  const btn   = document.getElementById('pa-submit');

  const showError = (msg) => {
    if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
  };
  if (errEl) errEl.style.display = 'none';

  if (!email || !pw) return showError('Please enter your email and password.');

  if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
  try {
    const user = await platformAdminSignIn(email, pw);
    if (!user.is_platform_admin) {
      signOut();
      return showError('This account is not a platform admin.');
    }
    revealGodNav();
    // Use the existing shell-bootstrap fn but with real user data + a clearly
    // labelled role. Initials come from the DB row when present, else first
    // two chars of the email local-part.
    const initials = user.initials || (user.email || '').slice(0, 2).toUpperCase();
    window.login('Platform Admin', user.name || user.email, initials);
    nav('god', document.getElementById('nav-god'));
  } catch (err) {
    showError(err?.message || 'Sign-in failed.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
  }
}

export function revealGodNav() {
  const el = document.getElementById('nav-god');
  if (el) el.style.display = '';
}

/**
 * If a JWT survives in sessionStorage from a previous session, restore the
 * shell without forcing a re-login. Called from app.js at startup.
 */
export async function autoResumePlatformAdmin() {
  const me = await rehydrateUser();
  if (!me || !me.user?.is_platform_admin) return false;
  const user = me.user;
  revealGodNav();
  const initials = user.initials || (user.email || '').slice(0, 2).toUpperCase();
  window.login('Platform Admin', user.name || user.email, initials);
  nav('god', document.getElementById('nav-god'));
  return true;
}

registerActions({
  // static index.html platform-admin sign-in panel
  'auth.showPlatform':   () => showPlatformAdminLogin(),
  'auth.submitPlatform': () => submitPlatformAdminLogin(),
});

// Enter-to-submit on the (static) platform-admin password field.
document.getElementById('pa-password')
  ?.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPlatformAdminLogin(); });
