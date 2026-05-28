// ─── Roles & Permissions ─────────────────────────────────────────────────────
// Config-section page with two views:
//   1. The role × permission matrix (default).
//   2. The per-role agents page (when ROLES_VIEW_AGENTS is set) — workload
//      bars, member CRUD, plus the role's permission grid.
//
// Admin role is protected: it can't be deleted, renamed, or stripped of the
// "roles" permission (self-lockout guard).
//
// Click/change handlers route through core/event-delegation.js.
// renderRoles is the only export consumed by app.js; reassignAgent,
// setAgentActive, deleteAgentPrompt are also imported directly by
// agents/index.js (the agent-detail page reuses them for the role
// dropdown + activate/delete buttons).
//
// External reaches (interim, via window): isAdmin, escAttr, showModal,
// closeModal, renderPage — all still in app.js. openAgentFromDash is
// a direct ES import from dashboard/index.js.
//
// AGENTS, TICKETS, ROLES_MATRIX, PERMISSIONS come from data.js via the
// global lexical env; ROLES_VIEW_AGENTS, AGENT_SELECTED, CURRENT_PAGE,
// SESSION come from core/state.js the same way.

import { registerActions, registerChangeActions } from '../core/event-delegation.js';
import { openAgentFromDash } from '../dashboard/index.js';
import { apiPost, apiPatch, apiDelete } from '../core/api-client.js';
import { getRoleUuid, setRoleUuid, clearRoleUuid, renameRoleUuid } from '../core/bootstrap.js';

function rolesApiBacked() {
  // If any role row carries a UUID lookup, the workspace is API-backed.
  return Object.keys(ROLES_MATRIX).some((name) => getRoleUuid(name));
}

// Snapshot the granted permission keys for a role from the local matrix.
function grantedKeys(roleName) {
  const cell = ROLES_MATRIX[roleName] || {};
  return Object.keys(cell).filter((k) => cell[k]);
}

export function renderRoles() {
  if (ROLES_VIEW_AGENTS) return renderRoleAgentsPage(ROLES_VIEW_AGENTS);
  const roles = Object.keys(ROLES_MATRIX);
  const admin = window.isAdmin();
  const headerCells = PERMISSIONS.map(p => `<th style="text-align:center;min-width:90px">${p.label}</th>`).join('');
  const rows = roles.map(r => {
    const count = AGENTS.filter(a => a.role === r).length;
    const cells = PERMISSIONS.map(p => {
      const v = !!ROLES_MATRIX[r][p.key];
      const lock = (r === 'Admin' && p.key === 'roles');
      if (admin && !lock) {
        return `<td style="text-align:center"><label class="toggle"><input type="checkbox" ${v?'checked':''} data-change-action="roles.togglePerm" data-role="${window.escAttr(r)}" data-perm="${window.escAttr(p.key)}"><span class="toggle-slider"></span></label></td>`;
      }
      return `<td style="text-align:center;color:${v?'var(--green)':'var(--ink4)'};font-weight:500">${v?'✓':'—'}</td>`;
    }).join('');
    const actions = admin ? `<td style="text-align:right;white-space:nowrap">${r==='Admin' ? '<span style="font-size:11px;color:var(--ink3)">protected</span>' : `<button class="btn btn-sm btn-danger" data-action="roles.deleteRole" data-role="${window.escAttr(r)}">Delete</button>`}</td>` : '';
    return `<tr>
      <td class="bold"><span class="link" data-action="roles.openAgents" data-role="${window.escAttr(r)}">${r}</span></td>
      <td style="text-align:center"><span class="link" data-action="roles.openAgents" data-role="${window.escAttr(r)}">${count}</span></td>
      ${cells}
      ${actions}
    </tr>`;
  }).join('');
  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Roles & Permissions</div>
        ${admin
          ? `<button class="btn btn-sm" data-action="roles.addPermission">+ Permission</button>
             <button class="btn btn-sm btn-solid" data-action="roles.addRole">+ Role</button>`
          : `<span style="font-size:11px;color:var(--ink3);font-style:italic">Read-only — admin access required to edit</span>`}
      </div>
      <div class="page-scroll">
        <div class="card">
          <div class="card-title">Permission Matrix</div>
          <div style="font-size:12px;color:var(--ink3);margin-bottom:12px">Toggle access per role. Click a role name or agent count to see who's in that role.</div>
          <div style="overflow-x:auto">
            <table class="tbl" style="min-width:720px">
              <thead><tr>
                <th style="text-align:left">Role</th>
                <th style="text-align:center">Agents</th>
                ${headerCells}
                ${admin?'<th></th>':''}
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;
}

function renderRoleAgentsPage(role) {
  const list = AGENTS.filter(a => a.role === role);
  const allRoles = Object.keys(ROLES_MATRIX);
  const admin = window.isAdmin();
  const perms = ROLES_MATRIX[role] || {};

  // Aggregate stats
  const activeN = list.filter(a => a.active).length;
  const totalOpen = list.reduce((sum, a) => sum + TICKETS.filter(t => t.agent === a.name && (t.status === 'open' || t.status === 'escalated')).length, 0);
  const avgLoad = activeN ? (totalOpen / activeN).toFixed(1) : '0';
  const csatScores = [];
  list.forEach(a => TICKETS.forEach(t => { if (t.agent === a.name && t.csat) csatScores.push(t.csat); }));
  const avgCSAT = csatScores.length ? csatScores.reduce((a, b) => a + b, 0) / csatScores.length : 0;
  const granted = PERMISSIONS.filter(p => perms[p.key]);

  // Per-member workload
  const memberLoad = list.map(a => ({
    a,
    open:  TICKETS.filter(t => t.agent === a.name && (t.status === 'open' || t.status === 'escalated')).length,
    total: TICKETS.filter(t => t.agent === a.name).length,
  })).sort((a, b) => b.open - a.open);
  const maxLoad = Math.max(...memberLoad.map(m => m.open), 1);

  const memberRows = list.map(a => {
    const otherRoleOpts = allRoles.map(r => `<option value="${r}" ${a.role===r?'selected':''}>${r}</option>`).join('');
    const open = TICKETS.filter(t => t.agent === a.name && (t.status === 'open' || t.status === 'escalated')).length;
    return `<tr>
      <td>
        <div style="display:flex;align-items:center;gap:8px;cursor:pointer" data-action="roles.openAgent" data-name="${window.escAttr(a.name)}">
          <div style="width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;color:#fff;flex-shrink:0;${a.active?'':'opacity:.5'}">${a.initials}</div>
          <span style="font-weight:500;color:var(--ink)">${a.name}</span>
        </div>
      </td>
      <td style="font-family:'DM Mono',monospace;font-size:12px;color:var(--ink2)">${open}</td>
      <td>${admin
        ? `<select class="filter-select" data-change-action="roles.reassign" data-name="${window.escAttr(a.name)}">${otherRoleOpts}</select>`
        : a.role}
      </td>
      <td><span class="tag ${a.active?'tag-resolved':'tag-gdpr'}">${a.active?'Active':'Deactivated'}</span></td>
      ${admin ? `<td style="text-align:right;white-space:nowrap">
        ${a.active
          ? `<button class="btn btn-sm" data-action="roles.setActive" data-name="${window.escAttr(a.name)}" data-active="false">Deactivate</button>`
          : `<button class="btn btn-sm" data-action="roles.setActive" data-name="${window.escAttr(a.name)}" data-active="true">Activate</button>`}
        <button class="btn btn-sm btn-danger" data-action="roles.deleteAgent" data-name="${window.escAttr(a.name)}">Delete</button>
      </td>` : ''}
    </tr>`;
  }).join('');

  const permCards = PERMISSIONS.map(p => {
    const v = !!perms[p.key];
    const lock = role === 'Admin' && p.key === 'roles';
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border:1px solid var(--rule);border-radius:var(--r);background:${v?'var(--purple-lt)':'var(--off2)'}">
      <div style="font-size:12.5px;color:${v?'var(--purple)':'var(--ink2)'};font-weight:${v?'500':'400'}">${p.label}</div>
      ${admin && !lock
        ? `<label class="toggle"><input type="checkbox" ${v?'checked':''} data-change-action="roles.togglePermAndRender" data-role="${window.escAttr(role)}" data-perm="${window.escAttr(p.key)}"><span class="toggle-slider"></span></label>`
        : `<span style="font-size:11px;color:${v?'var(--green)':'var(--ink4)'};font-family:'DM Mono',monospace">${v?'✓':'—'}</span>`}
    </div>`;
  }).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-breadcrumb">
          <span data-action="roles.closeAgents">Roles &amp; Permissions</span>
          <span class="tb-sep">/</span>
          <span style="color:var(--ink);font-weight:500">${role}</span>
          ${admin ? `<span style="margin-left:auto;display:flex;gap:6px">
            ${role !== 'Admin' ? `<button class="btn btn-sm" data-action="roles.rename" data-role="${window.escAttr(role)}">Rename</button>` : ''}
            <button class="btn btn-sm btn-solid" data-action="roles.addAgent" data-role="${window.escAttr(role)}">+ Agent</button>
            ${role !== 'Admin' ? `<button class="btn btn-sm btn-danger" data-action="roles.deleteRole" data-role="${window.escAttr(role)}">Delete role</button>` : ''}
          </span>` : ''}
        </div>
      </div>
      <div class="page-scroll">
        <div class="card" style="display:flex;gap:18px;align-items:center;padding:20px;margin-bottom:16px">
          <div style="width:54px;height:54px;border-radius:var(--r2);background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6l8-4z" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:20px;font-weight:700;color:var(--ink);letter-spacing:-.02em">${role}</div>
            <div style="font-size:13px;color:var(--ink3);margin-top:6px">${list.length} member${list.length===1?'':'s'} · ${granted.length} of ${PERMISSIONS.length} permissions${role==='Admin'?' · Protected role':''}</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
          <div class="r-tile"><div class="r-tile-n" style="color:var(--ink)">${list.length}</div><div class="r-tile-l" style="color:var(--ink3)">Members</div></div>
          <div class="r-tile" style="border-color:rgba(52,211,153,0.3);background:var(--green-lt)"><div class="r-tile-n" style="color:var(--green)">${activeN}</div><div class="r-tile-l" style="color:var(--green)">Active</div></div>
          <div class="r-tile" style="border-color:rgba(34,211,238,0.3);background:var(--cyan-lt)"><div class="r-tile-n" style="color:var(--cyan)">${avgLoad}</div><div class="r-tile-l" style="color:var(--cyan)">Avg open load</div></div>
          <div class="r-tile" style="border-color:rgba(251,191,36,0.3);background:var(--amber-lt)"><div class="r-tile-n" style="color:var(--amber)">${csatScores.length?avgCSAT.toFixed(1):'—'}</div><div class="r-tile-l" style="color:var(--amber)">Team CSAT</div></div>
        </div>

        <div class="card" style="margin-bottom:16px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
            <div class="card-title" style="margin:0">Permissions</div>
            <span style="font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace">${granted.length} / ${PERMISSIONS.length} granted</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px">
            ${permCards}
          </div>
          ${admin && role === 'Admin' ? '<div style="margin-top:12px;font-size:11px;color:var(--ink3);font-style:italic">The Roles &amp; Perms permission is locked on for the Admin role to prevent self-lockout.</div>' : ''}
        </div>

        ${list.length ? `
        <div class="card" style="margin-bottom:16px">
          <div class="card-title">Workload distribution</div>
          ${memberLoad.map(m => `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px;cursor:pointer" data-action="roles.openAgent" data-name="${window.escAttr(m.a.name)}">
              <div style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:#fff;flex-shrink:0;${m.a.active?'':'opacity:.5'}">${m.a.initials}</div>
              <div style="font-size:12px;color:var(--ink2);width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.a.name}</div>
              <div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden"><div style="background:${m.a.active?'var(--purple)':'var(--ink4)'};height:100%;width:${(m.open/maxLoad)*100}%"></div></div>
              <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);width:50px;text-align:right">${m.open} / ${m.total}</div>
            </div>`).join('')}
          <div style="font-size:10px;color:var(--ink3);margin-top:8px;font-family:'DM Mono',monospace">open / total tickets</div>
        </div>` : ''}

        <div class="card">
          <div class="card-title">${list.length} member${list.length===1?'':'s'}</div>
          <table class="tbl">
            <thead><tr>
              <th>Agent</th>
              <th>Open</th>
              <th>Role</th>
              <th>Status</th>
              ${admin?'<th style="text-align:right">Actions</th>':''}
            </tr></thead>
            <tbody>
              ${memberRows}
              ${list.length===0?`<tr><td colspan="${admin?5:4}"><div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No agents in this role</div><div class="empty-line"></div></div></td></tr>`:''}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function renameRolePrompt(oldName) {
  if (!window.isAdmin() || oldName === 'Admin') return;
  window.showModal('Rename role', `
    <div class="form-row">
      <label class="form-label">New name</label>
      <input class="form-input" id="rn-name" value="${String(oldName).replace(/"/g,'&quot;')}"/>
    </div>
  `, async () => {
    const newName = document.getElementById('rn-name').value.trim();
    if (!newName || newName === oldName) { window.closeModal(); return; }
    if (ROLES_MATRIX[newName]) return; // duplicate guard
    const uuid = getRoleUuid(oldName);
    if (uuid) {
      try { await apiPatch(`/api/v1/roles/${uuid}`, { name: newName }); }
      catch (err) { alert(`Couldn't rename: ${err?.message || err}`); return; }
      renameRoleUuid(oldName, newName);
    }
    ROLES_MATRIX[newName] = ROLES_MATRIX[oldName];
    delete ROLES_MATRIX[oldName];
    AGENTS.forEach(a => { if (a.role === oldName) a.role = newName; });
    if (ROLES_VIEW_AGENTS === oldName) ROLES_VIEW_AGENTS = newName;
    window.closeModal(); window.renderPage('roles');
  }, 'Rename');
}

function openRoleAgents(role) { ROLES_VIEW_AGENTS = role; window.renderPage('roles'); }
function closeRoleAgents()    { ROLES_VIEW_AGENTS = null; window.renderPage('roles'); }

async function togglePermission(role, perm, val) {
  if (!window.isAdmin() || !ROLES_MATRIX[role]) return;
  const uuid = getRoleUuid(role);
  if (uuid) {
    // Optimistic: flip locally, send the new permission set, roll back on
    // failure. Saves a round-trip when the user toggles multiple cells in
    // a row.
    const prev = !!ROLES_MATRIX[role][perm];
    ROLES_MATRIX[role][perm] = val;
    try {
      await apiPatch(`/api/v1/roles/${uuid}`, { permissions: grantedKeys(role) });
    } catch (err) {
      ROLES_MATRIX[role][perm] = prev;
      alert(`Couldn't update permission: ${err?.message || err}`);
      window.renderPage('roles');
      return;
    }
    return;
  }
  ROLES_MATRIX[role][perm] = val;
}

export function reassignAgent(name, newRole) {
  if (!window.isAdmin()) return;
  const a = AGENTS.find(x => x.name === name);
  if (a && ROLES_MATRIX[newRole]) a.role = newRole;
  window.renderPage(CURRENT_PAGE);
}

export function setAgentActive(name, active) {
  if (!window.isAdmin()) return;
  const a = AGENTS.find(x => x.name === name);
  if (a) a.active = active;
  window.renderPage(CURRENT_PAGE);
}

export function deleteAgentPrompt(name) {
  if (!window.isAdmin()) return;
  window.showModal('Delete agent', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently remove <strong style="color:var(--ink)">${name}</strong>? Tickets currently assigned to them will keep the historical assignment.</div>`, () => {
    const i = AGENTS.findIndex(a => a.name === name);
    if (i >= 0) AGENTS.splice(i, 1);
    if (AGENT_SELECTED === name) AGENT_SELECTED = null;
    window.closeModal(); window.renderPage(CURRENT_PAGE);
  }, 'Delete');
}

function addAgentToRolePrompt(role) {
  if (!window.isAdmin()) return;
  window.showModal(`Add agent to ${role}`, `
    <div class="form-grid">
      <div class="form-row"><label class="form-label">Full name</label><input class="form-input" id="ar-name" placeholder="Jane Doe"/></div>
      <div class="form-row"><label class="form-label">Initials</label><input class="form-input" id="ar-init" placeholder="JD" maxlength="3"/></div>
    </div>
  `, () => {
    const name = document.getElementById('ar-name').value.trim();
    let init = document.getElementById('ar-init').value.trim().toUpperCase();
    if (!name || AGENTS.find(a => a.name === name)) return;
    if (!init) init = name.split(/\s+/).map(w=>w[0]).join('').slice(0,2).toUpperCase();
    AGENTS.push({name, initials:init, role, active:true});
    window.closeModal(); window.renderPage('roles');
  }, 'Add');
}

function addRolePrompt() {
  if (!window.isAdmin()) return;
  window.showModal('New role', `
    <div class="form-row"><label class="form-label">Role name</label><input class="form-input" id="nr-name" placeholder="e.g. Compliance Officer"/></div>
    <div class="form-row"><label class="form-label">Copy permissions from</label>
      <select class="form-input" id="nr-base">
        <option value="">Start with no permissions</option>
        ${Object.keys(ROLES_MATRIX).map(r => `<option value="${r}">${r}</option>`).join('')}
      </select>
    </div>
  `, async () => {
    const name = document.getElementById('nr-name').value.trim();
    if (!name || ROLES_MATRIX[name]) return;
    const base = document.getElementById('nr-base').value;
    const perms = {};
    PERMISSIONS.forEach(p => { perms[p.key] = base ? !!ROLES_MATRIX[base][p.key] : false; });
    if (rolesApiBacked()) {
      const grants = PERMISSIONS.map((p) => p.key).filter((k) => perms[k]);
      let resp;
      try { resp = await apiPost('/api/v1/roles', { name, permissions: grants }); }
      catch (err) { alert(`Couldn't create role: ${err?.message || err}`); return; }
      setRoleUuid(resp.role.name, resp.role.id);
    }
    ROLES_MATRIX[name] = perms;
    window.closeModal(); window.renderPage('roles');
  }, 'Create');
}

function addPermissionPrompt() {
  if (!window.isAdmin()) return;
  window.showModal('New permission', `
    <div class="form-row"><label class="form-label">Display label</label><input class="form-input" id="np-label" placeholder="e.g. Billing Refunds"/></div>
    <div class="form-row"><label class="form-label">Internal key</label><input class="form-input" id="np-key" placeholder="auto-generated from label if blank"/></div>
  `, () => {
    let label = document.getElementById('np-label').value.trim();
    let key = document.getElementById('np-key').value.trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
    if (!key && label) key = label.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
    if (!label) label = key;
    if (!key || PERMISSIONS.find(p => p.key === key)) return;
    PERMISSIONS.push({key, label});
    Object.keys(ROLES_MATRIX).forEach(r => { if (ROLES_MATRIX[r][key] === undefined) ROLES_MATRIX[r][key] = false; });
    window.closeModal(); window.renderPage('roles');
  }, 'Add');
}

function deleteRolePrompt(role) {
  if (!window.isAdmin() || role === 'Admin') return;
  const inUse = AGENTS.filter(a => a.role === role).length;
  if (inUse > 0) {
    window.showModal('Cannot delete role', `<div style="font-size:13px;color:var(--ink2);line-height:1.6"><strong style="color:var(--ink)">${inUse}</strong> agent${inUse===1?' is':'s are'} still assigned to <strong style="color:var(--ink)">${role}</strong>. Reassign them to another role first.</div>`, null, null);
    return;
  }
  window.showModal('Delete role', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete the <strong style="color:var(--ink)">${role}</strong> role?</div>`, async () => {
    const uuid = getRoleUuid(role);
    if (uuid) {
      try { await apiDelete(`/api/v1/roles/${uuid}`); }
      catch (err) { alert(`Couldn't delete: ${err?.message || err}`); return; }
      clearRoleUuid(role);
    }
    delete ROLES_MATRIX[role];
    window.closeModal(); window.renderPage('roles');
  }, 'Delete');
}

registerActions({
  'roles.openAgents':    (ds) => openRoleAgents(ds.role),
  'roles.closeAgents':   () => closeRoleAgents(),
  'roles.addPermission': () => addPermissionPrompt(),
  'roles.addRole':       () => addRolePrompt(),
  'roles.deleteRole':    (ds) => deleteRolePrompt(ds.role),
  'roles.rename':        (ds) => renameRolePrompt(ds.role),
  'roles.addAgent':      (ds) => addAgentToRolePrompt(ds.role),
  'roles.openAgent':     (ds) => openAgentFromDash(ds.name),
  'roles.setActive':     (ds) => setAgentActive(ds.name, ds.active === 'true'),
  'roles.deleteAgent':   (ds) => deleteAgentPrompt(ds.name),
});

registerChangeActions({
  'roles.togglePerm':          (ds, el) => togglePermission(ds.role, ds.perm, el.checked),
  // Same as togglePerm but re-renders the page — used in the role-detail
  // view where other UI on the page reflects the current matrix state.
  'roles.togglePermAndRender': (ds, el) => { togglePermission(ds.role, ds.perm, el.checked); window.renderPage('roles'); },
  'roles.reassign':            (ds, el) => reassignAgent(ds.name, el.value),
});
