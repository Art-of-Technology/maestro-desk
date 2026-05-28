// Real-auth sign-in flow for agents.
//
// Parallels js/auth/platform-admin.js. The demo persona flow in
// js/auth/index.js stays untouched — that's still useful for offline UI
// work and sales demos. This module is the production path: real Supabase
// JWT, real user, real workspace membership.
//
// Flow:
//   1. User enters email + password
//   2. signIn() → JWT + { user, memberships }
//   3. memberships.length:
//        0 — error: "no workspace memberships" (platform admin should use the other link)
//        1 — auto-pick, store workspace_id, call window.login()
//        2+ — render an inline picker; user click → store + login()
//
// Surface:
//   showAgentLogin()         — swap auth screen to the agent panel
//   submitAgentLogin()       — handle the sign-in form submit
//   pickAgentWorkspace(id)   — workspace-picker click handler
//   autoResumeAgent()        — restore session on page reload

import { signIn, rehydrateUser, signOut } from '../core/auth-client.js';
import { setWorkspaceId, getWorkspaceId } from '../core/api-client.js';
import { registerActions } from '../core/event-delegation.js';
import { loadWorkspaceData } from '../core/bootstrap.js';
import { showAuthPanel } from './index.js';

// In-memory cache of the memberships list between sign-in and workspace pick.
// We need it to (a) render the picker, (b) look up the role when the user
// clicks one. Cleared after a successful login or when the panel is reset.
let _memberships = null;
let _user = null;

export function showAgentLogin() {
  showAuthPanel('agent');
  resetAgentPanel();
}

function resetAgentPanel() {
  _memberships = null;
  _user = null;
  const errEl = document.getElementById('ag-error');     if (errEl)  errEl.style.display  = 'none';
  const formEl = document.getElementById('ag-form');     if (formEl) formEl.style.display = 'block';
  const pickEl = document.getElementById('ag-picker');   if (pickEl) pickEl.style.display = 'none';
}

export async function submitAgentLogin() {
  const email = document.getElementById('ag-email')?.value.trim() || '';
  const pw    = document.getElementById('ag-password')?.value || '';
  const errEl = document.getElementById('ag-error');
  const btn   = document.getElementById('ag-submit');

  const showError = (msg) => {
    if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
  };
  if (errEl) errEl.style.display = 'none';

  if (!email || !pw) return showError('Please enter your email and password.');

  if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
  try {
    const me = await signIn(email, pw);
    _user = me.user;
    _memberships = me.memberships || [];

    if (_memberships.length === 0) {
      signOut();
      if (me.user?.is_platform_admin) {
        return showError('This account is platform-admin only. Use "Platform admin sign-in →".');
      }
      return showError('No workspace memberships found for this account.');
    }

    if (_memberships.length === 1) {
      enterWorkspace(_memberships[0]);
      return;
    }

    // 2+ memberships → render the picker.
    renderPicker(_memberships);
  } catch (err) {
    showError(err?.message || 'Sign-in failed.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
  }
}

function renderPicker(memberships) {
  const formEl = document.getElementById('ag-form');
  const pickEl = document.getElementById('ag-picker');
  if (formEl) formEl.style.display = 'none';
  if (pickEl) {
    pickEl.style.display = 'block';
    pickEl.innerHTML = `
      <div class="auth-sub" style="margin-bottom:14px">Choose a workspace to sign into.</div>
      <div class="auth-accounts" style="margin-top:0;border-top:none;padding-top:0">
        ${memberships.map((m, i) => `
          <div class="auth-account" data-action="agent.pickWorkspace" data-idx="${i}">
            <div class="auth-account-av">${escInitials(m.workspace_name)}</div>
            <div>
              <div class="auth-account-name">${escText(m.workspace_name)}</div>
              <div class="auth-account-role">${escText(m.role_name || 'Member')}${m.suspended ? ' · Suspended' : ''}</div>
            </div>
          </div>
        `).join('')}
      </div>`;
  }
}

// Picker click handler — wired via core/event-delegation.
function pickAgentWorkspace(ds) {
  const i = parseInt(ds.idx, 10);
  if (!_memberships || isNaN(i) || !_memberships[i]) return;
  enterWorkspace(_memberships[i]);
}

registerActions({
  'agent.pickWorkspace': (ds) => pickAgentWorkspace(ds),
});

async function enterWorkspace(m) {
  if (m.suspended) {
    showSignInError(`${m.workspace_name} is suspended. Contact your platform admin.`);
    return;
  }
  setWorkspaceId(m.workspace_id);
  try {
    await bootShell(_user, m);
  } catch (err) {
    // Bootstrap failed → unwind so the user lands back on the form rather
    // than a half-booted shell with stale demo data still in the globals.
    setWorkspaceId(null);
    showSignInError(err?.message || 'Failed to load workspace data.');
  }
}

function showSignInError(msg) {
  const errEl = document.getElementById('ag-error');
  if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
  const formEl = document.getElementById('ag-form');
  const pickEl = document.getElementById('ag-picker');
  if (formEl) formEl.style.display = 'block';
  if (pickEl) pickEl.style.display = 'none';
}

async function bootShell(user, membership) {
  // Load tickets/customers/agents from the API before showing the shell,
  // so the dashboard renders against real data on first paint (not demo
  // data that then flickers when the fetch completes).
  await loadWorkspaceData();
  const initials = user.initials || deriveInitials(user.name, user.email);
  const role     = membership.role_name || (membership.is_admin ? 'Admin' : 'Senior Agent');
  window.login(role, user.name || user.email, initials);
}

function deriveInitials(name, email) {
  if (name) {
    const parts = name.trim().split(/\s+/);
    const first = parts[0]?.[0] || '';
    const last  = parts[1]?.[0] || '';
    const init  = (first + last).toUpperCase();
    if (init) return init;
  }
  return (email || '??').slice(0, 2).toUpperCase();
}

function escInitials(workspaceName) {
  return escText((workspaceName || '?').split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?');
}

function escText(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[ch]));
}

/**
 * Restore an agent session from sessionStorage. Returns true if the SPA
 * was bootstrapped into the app shell.
 *
 * A stored workspace_id is the user's explicit "enter as agent" signal —
 * this wins over the platform-admin auto-resume even for users who are
 * both. Sign out (or hit the god nav link inside the app) to clear it.
 */
export async function autoResumeAgent() {
  const workspaceId = getWorkspaceId();
  if (!workspaceId) return false;

  const me = await rehydrateUser();
  if (!me) return false;

  const m = (me.memberships || []).find(x => x.workspace_id === workspaceId);
  if (!m || m.suspended) {
    // Stored workspace_id no longer valid (revoked / suspended) — drop it
    // and fall through to the next resume path or the auth screen.
    setWorkspaceId(null);
    return false;
  }
  try {
    await bootShell(me.user, m);
  } catch (err) {
    console.warn('[autoResumeAgent] bootstrap failed:', err);
    setWorkspaceId(null);
    return false;
  }
  return true;
}
