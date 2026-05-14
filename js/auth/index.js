// ─── Auth panel ──────────────────────────────────────────────────────────────
// Pre-login screen — three swappable panels (login / forgot password /
// create account) plus the SSO buttons and password-strength meter.
// All handlers transition into the app by calling window.login(...),
// which lives in app.js and owns the app-shell setup (sidebar avatar,
// SLA refresh, snooze polling, dashboard render).
//
// External reaches (interim, via window): login — still in app.js.
//
// The auth screen DOM lives in index.html (#auth-screen + the three
// #auth-{login,forgot,create} panels); this module never touches anything
// outside that subtree.

export function showAuthPanel(panel) {
  ['login','forgot','create'].forEach(p => {
    const el = document.getElementById('auth-'+p);
    if (el) el.style.display = p === panel ? 'block' : 'none';
  });
  // Clear stale error/confirmation messages
  ['login-error','create-error','create-confirm','forgot-confirm'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  });
}

function isValidEmail(e) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); }

export function togglePassword(id) {
  const el = document.getElementById(id); if (!el) return;
  el.type = el.type === 'password' ? 'text' : 'password';
}

export function ssoLogin(provider) {
  const presets = {
    google:    { name: 'Sofia Reyes',  initials: 'SR', role: 'Senior Agent' },
    microsoft: { name: 'James Webb',   initials: 'JW', role: 'Senior Agent' },
    saml:      { name: 'Emma Clarke',  initials: 'EC', role: 'Admin' },
  };
  const p = presets[provider] || presets.saml;
  window.login(p.role, p.name, p.initials);
}

function deriveNameFromEmail(email) {
  const local = email.split('@')[0];
  const parts = local.split(/[._-]/).filter(Boolean);
  const cap = w => w ? w[0].toUpperCase() + w.slice(1) : '';
  const first = cap(parts[0]) || 'User';
  const last  = cap(parts[1]) || '';
  return { name: (first + ' ' + last).trim(), initials: ((first[0]||'') + (last[0]||'')).toUpperCase() || first[0] };
}

export function submitLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pw    = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.style.display = 'none';
  if (!email || !pw) { errEl.textContent = 'Please enter your email and password.'; errEl.style.display = 'block'; return; }
  if (!isValidEmail(email)) { errEl.textContent = 'Please enter a valid email.'; errEl.style.display = 'block'; return; }
  if (pw.length < 6) { errEl.textContent = 'Invalid email or password.'; errEl.style.display = 'block'; return; }
  const { name, initials } = deriveNameFromEmail(email);
  window.login('Senior Agent', name, initials);
}

export function submitForgot() {
  const email = document.getElementById('forgot-email')?.value.trim() || '';
  const c = document.getElementById('forgot-confirm');
  if (!isValidEmail(email)) {
    if (c) { c.textContent = 'Please enter a valid email address.'; c.style.color = 'var(--red)'; c.style.display = 'block'; }
    return;
  }
  if (c) { c.textContent = 'Reset link sent — check your inbox.'; c.style.color = 'var(--green)'; c.style.display = 'block'; }
}

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

export function updatePwStrength(pw) {
  const wrap = document.getElementById('pw-strength-wrap');
  const bar  = document.getElementById('pw-strength-bar');
  const text = document.getElementById('pw-strength-text');
  if (!wrap || !bar || !text) return;
  if (!pw) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  const score = pwScore(pw);
  const labels = ['Very weak','Weak','Fair','Good','Strong','Very strong'];
  const colors = ['var(--red)','var(--red)','var(--amber)','var(--amber)','var(--green)','var(--green)'];
  bar.style.width = (score / 5) * 100 + '%';
  bar.style.background = colors[score];
  text.textContent = labels[score];
  text.style.color = colors[score];
}

export function submitCreate() {
  const first = document.getElementById('ca-first').value.trim();
  const last  = document.getElementById('ca-last').value.trim();
  const email = document.getElementById('ca-email').value.trim();
  const pw    = document.getElementById('ca-password').value;
  const terms = document.getElementById('ca-terms').checked;
  const errEl = document.getElementById('create-error');
  const okEl  = document.getElementById('create-confirm');
  errEl.style.display = 'none';
  okEl.style.display = 'none';
  if (!first || !last)         { errEl.textContent = 'Please enter your first and last name.'; errEl.style.display = 'block'; return; }
  if (!isValidEmail(email))    { errEl.textContent = 'Please enter a valid work email.';      errEl.style.display = 'block'; return; }
  if (pwScore(pw) < 3)         { errEl.textContent = 'Password is too weak — aim for "Good" or higher.'; errEl.style.display = 'block'; return; }
  if (!terms)                  { errEl.textContent = 'Please accept the terms.';              errEl.style.display = 'block'; return; }
  okEl.style.display = 'block';
}
