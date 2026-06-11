// ─── Auth panel ──────────────────────────────────────────────────────────────
// Pre-login screen. The real email/password sign-in lives in
// auth/agent-login.js (it owns the #auth-login form + the `auth.submitLogin`
// action and the workspace routing). This module owns the panel switcher, the
// self-serve "forgot password" request, and the set-password landing entered
// from the emailed reset/invite link.
//
// The auth screen DOM is static in index.html; handlers are delegated as
// `auth.*` actions. showAuthPanel stays exported (app.js + agent-login flow).

import { registerActions } from '../core/event-delegation.js';
import { resetPassword, requestPasswordReset } from '../core/auth-client.js';

export function showAuthPanel(panel) {
  ['login', 'forgot', 'set-password'].forEach((p) => {
    const el = document.getElementById('auth-' + p);
    if (el) el.style.display = p === panel ? 'block' : 'none';
  });
  // Clear stale error/confirmation messages.
  ['login-error', 'forgot-confirm', 'sp-error', 'sp-confirm'].forEach((id) => {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  });
}

// Set-password landing — entered from the emailed reset/invite link. app.js
// calls beginSetPassword(token) on startup when the URL carries ?reset_token.
let _resetToken = null;
export function beginSetPassword(token) {
  _resetToken = token;
  showAuthPanel('set-password');
}

function isValidEmail(e) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); }

function togglePassword(id) {
  const el = document.getElementById(id); if (!el) return;
  el.type = el.type === 'password' ? 'text' : 'password';
}

// Password strength (0–5) — gates the set-password form.
function pwScore(pw) {
  let s = 0;
  if (!pw) return 0;
  if (pw.length >= 8)  s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return s;
}

async function submitForgot() {
  const email = document.getElementById('forgot-email')?.value.trim() || '';
  const c = document.getElementById('forgot-confirm');
  const setMsg = (text, color) => { if (c) { c.textContent = text; c.style.color = color; c.style.display = 'block'; } };
  if (!isValidEmail(email)) return setMsg('Please enter a valid email address.', 'var(--red)');
  try {
    await requestPasswordReset(email);
  } catch (err) {
    return setMsg(err?.message || 'Could not send the reset link.', 'var(--red)');
  }
  // Enumeration-safe — confirm regardless of whether the address has an account.
  setMsg("If that email has an account, a reset link is on its way.", 'var(--green)');
}

async function submitSetPassword() {
  const pw    = document.getElementById('sp-password')?.value || '';
  const errEl = document.getElementById('sp-error');
  const okEl  = document.getElementById('sp-confirm');
  const btn   = document.getElementById('sp-submit');
  if (errEl) errEl.style.display = 'none';
  if (okEl)  okEl.style.display = 'none';
  if (pwScore(pw) < 3) {
    if (errEl) { errEl.textContent = 'Password is too weak — aim for "Good" or higher.'; errEl.style.display = 'block'; }
    return;
  }
  if (!_resetToken) {
    if (errEl) { errEl.textContent = 'Missing or expired reset link — request a new one.'; errEl.style.display = 'block'; }
    return;
  }
  if (btn) btn.disabled = true;
  try {
    await resetPassword(_resetToken, pw);
    _resetToken = null;
    if (okEl) okEl.style.display = 'block';
    // Send them to sign in with their new password after a beat.
    setTimeout(() => showAuthPanel('login'), 1500);
  } catch (err) {
    if (errEl) { errEl.textContent = err?.message || 'Could not set password.'; errEl.style.display = 'block'; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

registerActions({
  'auth.togglePw':          (ds) => togglePassword(ds.target),
  'auth.showPanel':         (ds) => showAuthPanel(ds.panel),
  'auth.submitForgot':      () => submitForgot(),
  'auth.submitSetPassword': () => submitSetPassword(),
});
