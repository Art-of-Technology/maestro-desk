// Platform-admin (God) entry + reload-resume.
//
// The single login form (auth/agent-login.js) calls enterGod() when the
// signed-in user is a platform admin; autoResumePlatformAdmin() restores the
// God view on page reload when a platform-admin session survives.

import { nav } from '../core/router.js';
import { rehydrateUser } from '../core/auth-client.js';

export function revealGodNav() {
  const el = document.getElementById('nav-god');
  if (el) el.style.display = '';
}

// Enter the platform/brand-management (God) view for an authenticated
// platform-admin user. Reuses the app-shell bootstrap via window.login with a
// clearly-labelled role; initials from the DB row, else the email local-part.
export function enterGod(user) {
  revealGodNav();
  const initials = user.initials || (user.email || 'PA').slice(0, 2).toUpperCase();
  window.login('Platform Admin', user.name || user.email, initials, user.id);
  nav('god', document.getElementById('nav-god'));
}

// If a platform-admin JWT survives in sessionStorage, restore the God view
// without a re-login. Called from app.js at startup (after autoResumeAgent).
export async function autoResumePlatformAdmin() {
  const me = await rehydrateUser();
  if (!me || !me.user?.is_platform_admin) return false;
  enterGod(me.user);
  return true;
}
