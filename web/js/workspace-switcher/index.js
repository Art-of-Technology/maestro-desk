// ─── In-session workspace / brand switcher ──────────────────────────────────
// An agent who belongs to more than one workspace (one owner running several
// brands, an agent covering all the brands they're employed for) can switch
// brand without round-tripping through the login screen.
//
// The trigger is the sidebar brand block (`.sidebar .sb-logo`): when the
// signed-in user has 2+ memberships it gains a caret and opens a popover
// listing every workspace they can enter. Picking one re-stamps the session
// (X-Workspace-Id + X-Brand-Id), reloads workspace data, re-themes the shell,
// and lands on the dashboard — the same end state as signing in fresh, minus
// the auth round-trip.
//
// Platform admins (God) switch brands through the god panel's "Enter brand"
// instead, so this switcher is for real-auth agents only and is never enabled
// for them or for demo personas (no userId).
//
// External reaches via the window bridge: applyWorkspaceBrand /
// resetWorkspaceBrand (white-label hooks, app.js-local). Everything else is a
// direct ES import.

import { apiGet, getWorkspaceId, getBrandId, setWorkspaceId, setBrandId } from '../core/api-client.js';
import { loadWorkspaceData } from '../core/bootstrap.js';
import { startListSync, stopListSync } from '../tickets/list-sync.js';
import { startRealtime, stopRealtime } from '../core/realtime.js';
import { stopPresence } from '../core/presence.js';
import { renderPage } from '../core/router.js';
import { registerActions } from '../core/event-delegation.js';
import { SESSION, setSession } from '../core/state.js';
import { initTaglineSdk } from '../tagline-sdk/index.js';
import { isSidebarCollapsed } from '../core/sidebar.js';

let _memberships = [];   // cached from /whoami; refreshed each time the popover opens
let _switching   = false;

function logoEl() { return document.querySelector('.sidebar .sb-logo'); }

/**
 * Enable the switcher for a freshly-entered real-auth session. Fetches the
 * caller's memberships; only wires the trigger when there are 2+ to switch
 * between. Safe to call on every workspace entry (login / auto-resume) — it
 * re-reads the latest membership set and re-applies the trigger state.
 *
 * userId is null for demo personas; they never have an API session, so skip.
 */
export async function initWorkspaceSwitcher(userId) {
  if (!userId) { disableTrigger(); return; }
  try {
    const me = await apiGet('/api/v1/whoami', { workspace: false });
    _memberships = me.memberships || [];
  } catch {
    _memberships = [];
  }
  if (_memberships.length >= 2) enableTrigger();
  else disableTrigger();
}

function enableTrigger() {
  const el = logoEl();
  if (!el) return;
  el.classList.add('switchable');
  el.setAttribute('data-action', 'wsswitch.open');
  // This runs after memberships resolve, which is well after core/sidebar.js
  // applied the stored collapsed state — so ask, rather than assume the
  // sidebar is expanded. Collapsed, the trigger is CSS-neutralised and must
  // stay out of the tab order (core/sidebar.js owns the same rule on toggle).
  el.setAttribute('tabindex', isSidebarCollapsed() ? '-1' : '0');
  el.setAttribute('role', 'button');
  el.setAttribute('aria-haspopup', 'true');
  el.setAttribute('title', 'Switch workspace');
  if (!el.querySelector('.sb-logo-caret')) {
    const caret = document.createElement('span');
    caret.className = 'sb-logo-caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.textContent = '⌄';
    el.appendChild(caret);
  }
}

function disableTrigger() {
  const el = logoEl();
  if (!el) return;
  el.classList.remove('switchable');
  el.removeAttribute('data-action');
  el.removeAttribute('tabindex');
  el.removeAttribute('role');
  el.removeAttribute('aria-haspopup');
  el.removeAttribute('title');
  el.querySelector('.sb-logo-caret')?.remove();
}

// ─── Popover ────────────────────────────────────────────────────────────────

function openSwitcher() {
  if (_switching) return;
  closeSwitcher();
  renderPopover();
  // Refresh memberships in the background so a mid-session grant/revoke shows
  // up without a reload; re-render in place if still open when it returns.
  apiGet('/api/v1/whoami', { workspace: false })
    .then((me) => {
      _memberships = me.memberships || [];
      if (document.getElementById('ws-switch-backdrop')) renderPopover();
      if (_memberships.length < 2) { closeSwitcher(); disableTrigger(); }
    })
    .catch(() => {});
}

function closeSwitcher() {
  document.getElementById('ws-switch-backdrop')?.remove();
  document.removeEventListener('keydown', onKeydown, true);
}

function onKeydown(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeSwitcher(); }
}

function renderPopover() {
  closeSwitcher();
  const anchor = logoEl();
  if (!anchor) return;
  const current = getWorkspaceId();
  const rect = anchor.getBoundingClientRect();

  const backdrop = document.createElement('div');
  backdrop.id = 'ws-switch-backdrop';
  backdrop.className = 'ws-switch-backdrop';
  backdrop.setAttribute('data-action', 'wsswitch.close');

  const pop = document.createElement('div');
  pop.className = 'ws-switch-pop';
  // Absorber: clicks inside the panel but not on a row do nothing (don't close).
  pop.setAttribute('data-action', '');
  // Anchor under the brand block, but clamp the left edge so the panel never
  // clips past the viewport on a narrow window (the CSS width is 248px).
  const POP_W = 248;
  const left = Math.max(8, Math.min(rect.left + 8, window.innerWidth - POP_W - 12));
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top  = `${Math.round(rect.bottom + 4)}px`;

  pop.innerHTML = `
    <div class="ws-switch-head">Switch workspace</div>
    <div class="ws-switch-list">
      ${_memberships.map((m, i) => {
        const isCurrent = m.workspace_id === current;
        const role = m.role_name || (m.is_admin ? 'Admin' : 'Member');
        const sub  = m.suspended ? 'Suspended' : (isCurrent ? 'Current' : role);
        return `
          <div class="auth-account ws-switch-row${isCurrent ? ' is-current' : ''}${m.suspended ? ' is-suspended' : ''}"
               ${m.suspended ? '' : `data-action="wsswitch.pick" data-idx="${i}"`}
               ${isCurrent ? 'aria-current="true"' : ''}>
            <div class="auth-account-av">${escInitials(m.workspace_name)}</div>
            <div style="flex:1;min-width:0">
              <div class="auth-account-name">${escText(m.workspace_name)}</div>
              <div class="auth-account-role">${escText(sub)}</div>
            </div>
            ${isCurrent ? '<span class="ws-switch-check" aria-hidden="true">✓</span>' : ''}
          </div>`;
      }).join('')}
    </div>`;

  backdrop.appendChild(pop);
  document.body.appendChild(backdrop);
  document.addEventListener('keydown', onKeydown, true);
}

// ─── Switch ───────────────────────────────────────────────────────────────

function pickWorkspace(ds) {
  const i = parseInt(ds.idx, 10);
  if (isNaN(i) || !_memberships[i]) return;
  switchWorkspace(_memberships[i]);
}

async function switchWorkspace(m) {
  if (_switching) return;
  if (m.workspace_id === getWorkspaceId()) { closeSwitcher(); return; }
  if (m.suspended) { closeSwitcher(); alert(`${m.workspace_name} is suspended. Contact your platform admin.`); return; }

  const prevWs    = getWorkspaceId();
  const prevBrand = getBrandId();
  _switching = true;
  closeSwitcher();

  // Tear down the previous workspace's live channels before swapping context —
  // list-sync polls, the Pubby socket, and any open-entity presence row are
  // all workspace-scoped.
  stopListSync();
  stopRealtime();
  stopPresence();

  setWorkspaceId(m.workspace_id);
  setBrandId(m.maestro_brand_id || null);

  try {
    await loadWorkspaceData();
  } catch (err) {
    // Roll back to the workspace we came from so the agent isn't stranded in a
    // half-loaded one; best-effort reload of the previous data set.
    setWorkspaceId(prevWs);
    setBrandId(prevBrand);
    try { await loadWorkspaceData(); } catch { /* previous is gone too — leave as-is */ }
    startListSync();
    startRealtime();
    _switching = false;
    alert(`Couldn't switch to ${m.workspace_name}: ${err?.message || err}`);
    return;
  }

  applyIdentity(m);
  window.resetWorkspaceBrand?.();
  window.applyWorkspaceBrand?.({
    name:         m.workspace_name,
    slug:         m.workspace_slug,
    logoUrl:      m.workspace_logo_url,
    primaryColor: m.workspace_primary_color,
  });
  startListSync();
  startRealtime();
  // Re-identify to Tagline so announcement targeting (workspace_id, role)
  // tracks the workspace we just entered — this path never re-runs login().
  initTaglineSdk(SESSION?.userId);
  _switching = false;
  renderPage('dashboard');
}

// Re-stamp the per-workspace bits of the session (role + custom-field rights
// vary by membership) and reflect them in the sidebar / profile chrome. Name,
// initials, and userId carry over unchanged.
function applyIdentity(m) {
  const role = m.role_name || (m.is_admin ? 'Admin' : 'Senior Agent');
  setSession({ ...SESSION, role, canManageCustomFields: m.can_manage_custom_fields === true, canDelete: m.can_delete === true });
  setText('sb-urole', role);
  setText('pf-role-lg', role);
  const navRoles = document.getElementById('nav-roles');
  if (navRoles) navRoles.style.opacity = role === 'Read Only' ? '.3' : '';
}

function setText(id, txt) {
  const el = document.getElementById(id);
  if (el) el.textContent = txt;
}

registerActions({
  'wsswitch.open':  () => openSwitcher(),
  'wsswitch.close': () => closeSwitcher(),
  'wsswitch.pick':  (ds) => pickWorkspace(ds),
});

// Open on Enter/Space when the trigger has keyboard focus.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = logoEl();
  if (el && el.classList.contains('switchable') && document.activeElement === el) {
    e.preventDefault();
    openSwitcher();
  }
});

function escInitials(workspaceName) {
  return escText((workspaceName || '?').split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?');
}

function escText(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[ch]));
}
