// THE sign-in flow for the SPA. One email/password form (#auth-login) drives
// this. On sign-in we hit /api/v1/whoami and route:
//   - platform admin (God)   → platform/God view (enterGod), by default
//   - 1 workspace membership  → auto-enter that workspace
//   - 2+ memberships          → inline workspace picker
//   - 0 memberships, not God   → "no access — ask your admin for an invite"
//
// autoResumeAgent() restores a workspace session on reload (stored workspace_id);
// God reload is handled by autoResumePlatformAdmin() (see platform-admin.js).

import { signIn, rehydrateUser, signOut } from '../core/auth-client.js';
import { setWorkspaceId, getWorkspaceId } from '../core/api-client.js';
import { registerActions } from '../core/event-delegation.js';
import { loadWorkspaceData } from '../core/bootstrap.js';
import { enterGod } from './platform-admin.js';

// Cached between sign-in and workspace pick (for the 2+ picker click handler).
let _memberships = null;
let _user = null;

function showError(msg) {
  const errEl = document.getElementById('login-error');
  if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
  // Always restore the form view (hide any picker) so the user can retry.
  const formEl = document.getElementById('login-form');
  const pickEl = document.getElementById('login-picker');
  if (formEl) formEl.style.display = 'block';
  if (pickEl) pickEl.style.display = 'none';
}

async function submitLogin() {
  const email = document.getElementById('login-email')?.value.trim() || '';
  const pw    = document.getElementById('login-password')?.value || '';
  const errEl = document.getElementById('login-error');
  const btn   = document.getElementById('login-submit');
  if (errEl) errEl.style.display = 'none';
  if (!email || !pw) return showError('Please enter your email and password.');

  if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
  try {
    const me = await signIn(email, pw);
    _user = me.user;
    _memberships = me.memberships || [];

    // God accounts land in the platform/brand-management view by default.
    if (_user?.is_platform_admin) { enterGod(_user); return; }

    if (_memberships.length === 0) {
      signOut();
      return showError('No workspace access yet — ask your admin for an invite.');
    }
    if (_memberships.length === 1) { enterWorkspace(_memberships[0]); return; }
    renderPicker(_memberships);
  } catch (err) {
    showError(err?.message || 'Sign-in failed.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
  }
}

function renderPicker(memberships) {
  const formEl = document.getElementById('login-form');
  const pickEl = document.getElementById('login-picker');
  if (formEl) formEl.style.display = 'none';
  if (!pickEl) return;
  pickEl.style.display = 'block';
  pickEl.innerHTML = `
    <div class="auth-sub" style="margin:8px 0 14px;text-align:center">Choose a workspace to sign into.</div>
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

function pickAgentWorkspace(ds) {
  const i = parseInt(ds.idx, 10);
  if (!_memberships || isNaN(i) || !_memberships[i]) return;
  enterWorkspace(_memberships[i]);
}

registerActions({
  'auth.submitLogin':    () => submitLogin(),
  'agent.pickWorkspace': (ds) => pickAgentWorkspace(ds),
});

// Enter-to-submit on the (static) login password field.
document.getElementById('login-password')
  ?.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLogin(); });

async function enterWorkspace(m) {
  if (m.suspended) { showError(`${m.workspace_name} is suspended. Contact your platform admin.`); return; }
  setWorkspaceId(m.workspace_id);
  try {
    await bootShell(_user, m);
  } catch (err) {
    // Unwind so the user lands back on the form, not a half-booted shell.
    setWorkspaceId(null);
    showError(err?.message || 'Failed to load workspace data.');
  }
}

async function bootShell(user, membership) {
  await loadWorkspaceData();
  const initials = user.initials || deriveInitials(user.name, user.email);
  const role     = membership.role_name || (membership.is_admin ? 'Admin' : 'Senior Agent');
  window.login(role, user.name || user.email, initials, user.id);
  window.applyWorkspaceBrand?.({
    name:         membership.workspace_name,
    slug:         membership.workspace_slug,
    logoUrl:      membership.workspace_logo_url,
    primaryColor: membership.workspace_primary_color,
  });
}

function deriveInitials(name, email) {
  if (name) {
    const parts = name.trim().split(/\s+/);
    const init  = ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase();
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
 * Restore an agent workspace session on page reload. A stored workspace_id is
 * the user's explicit "enter this workspace" signal and wins over the God
 * auto-resume. Returns true if the shell was bootstrapped.
 */
export async function autoResumeAgent() {
  const workspaceId = getWorkspaceId();
  if (!workspaceId) return false;
  const me = await rehydrateUser();
  if (!me) return false;
  const m = (me.memberships || []).find(x => x.workspace_id === workspaceId);
  if (!m || m.suspended) { setWorkspaceId(null); return false; }
  try {
    await bootShell(me.user, m);
  } catch (err) {
    console.warn('[autoResumeAgent] bootstrap failed:', err);
    setWorkspaceId(null);
    return false;
  }
  return true;
}
