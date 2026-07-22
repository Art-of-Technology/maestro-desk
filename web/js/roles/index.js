// ─── Roles ─────────────────────────────────────────────────────────────────
// Config-section page with two views:
//   1. The roles list (default) — each role with its agent count.
//   2. The per-role agents page (when ROLES_VIEW_AGENTS is set) — workload
//      bars and member CRUD.
//
// Authorization is the binary is_admin flag enforced server-side; there is no
// granular per-permission grid. The Admin role is protected: it can't be
// deleted or renamed.
//
// Click/change handlers route through core/event-delegation.js.
// renderRoles is the only export consumed by app.js; reassignAgent,
// setAgentActive, deleteAgentPrompt are also imported directly by
// agents/index.js (the agent-detail page reuses them for the role
// dropdown + activate/delete buttons).
//
// External reaches (interim, via window): isAdmin, escAttr — all still in
// app.js. showModal, closeModal and openAgentFromDash (dashboard/index.js)
// are direct ES imports.

import { AGENTS, ROLES, TICKETS } from '../core/data.js';
import { AGENT_SELECTED, CURRENT_PAGE, ROLES_VIEW_AGENTS, setAgentSelected, setRolesViewAgents } from '../core/state.js';
import { renderPage } from '../core/router.js';
import { registerActions, registerChangeActions } from '../core/event-delegation.js';
import { openAgentFromDash } from '../dashboard/index.js';
import { apiPost, apiPatch, apiDelete } from '../core/api-client.js';
import { getRoleUuid, setRoleUuid, clearRoleUuid, renameRoleUuid, getRoleCanManageCF, setRoleCanManageCF } from '../core/bootstrap.js';
import { showModal, closeModal } from '../core/modal.js';

function rolesApiBacked() {
  // If any role carries a UUID lookup, the workspace is API-backed.
  return ROLES.some((name) => getRoleUuid(name));
}

export function renderRoles() {
  if (ROLES_VIEW_AGENTS) return renderRoleAgentsPage(ROLES_VIEW_AGENTS);
  const admin = window.isAdmin();
  const rows = ROLES.map(r => {
    const count = AGENTS.filter(a => a.role === r).length;
    // Admins always manage custom fields (locked on); other roles carry the
    // can_manage_custom_fields flag, which admins can toggle here.
    const isAdminRole = r === 'Admin';
    const cf = isAdminRole || getRoleCanManageCF(r);
    const cfCell = admin
      ? `<td style="text-align:center">${isAdminRole
          ? '<span class="tag" style="font-size:10px;color:var(--green);background:transparent;border-color:var(--green)" title="Admins always manage custom fields">always</span>'
          : `<label class="toggle"><input type="checkbox" ${cf?'checked':''} data-change-action="roles.toggleCustomFields" data-role="${window.escAttr(r)}"><span class="toggle-slider"></span></label>`}</td>`
      : `<td style="text-align:center;color:${cf?'var(--green)':'var(--ink4)'};font-weight:500">${cf?'✓':'—'}</td>`;
    const actions = admin ? `<td style="text-align:right;white-space:nowrap">${isAdminRole ? '<span style="font-size:11px;color:var(--ink3)">protected</span>' : `<button class="btn btn-sm btn-danger" data-action="roles.deleteRole" data-role="${window.escAttr(r)}">Delete</button>`}</td>` : '';
    return `<tr>
      <td class="bold"><span class="link" data-action="roles.openAgents" data-role="${window.escAttr(r)}">${r}</span></td>
      <td style="text-align:center"><span class="link" data-action="roles.openAgents" data-role="${window.escAttr(r)}">${count}</span></td>
      ${cfCell}
      ${actions}
    </tr>`;
  }).join('');
  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Roles</div>
        ${admin
          ? `<button class="btn btn-sm btn-solid" data-action="roles.addRole">+ Role</button>`
          : `<span style="font-size:11px;color:var(--ink3);font-style:italic">Read-only — admin access required to edit</span>`}
      </div>
      <div class="page-scroll">
        <div class="card">
          <div class="card-title">Roles</div>
          <div style="font-size:12px;color:var(--ink3);margin-bottom:12px">Click a role name or agent count to see who's in that role. The Admin role has full access; every other role is non-admin. "Manage custom fields" lets a role create and remove custom-field definitions (all agents can fill in values regardless).</div>
          <table class="tbl">
            <thead><tr>
              <th style="text-align:left">Role</th>
              <th style="text-align:center">Agents</th>
              <th style="text-align:center">Manage custom fields</th>
              ${admin?'<th></th>':''}
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function renderRoleAgentsPage(role) {
  const list = AGENTS.filter(a => a.role === role);
  const allRoles = ROLES;
  const admin = window.isAdmin();

  // Aggregate stats
  const activeN = list.filter(a => a.active).length;
  const totalOpen = list.reduce((sum, a) => sum + TICKETS.filter(t => t.agent === a.name && (t.status === 'open' || t.status === 'escalated')).length, 0);
  const avgLoad = activeN ? (totalOpen / activeN).toFixed(1) : '0';
  const csatScores = [];
  list.forEach(a => TICKETS.forEach(t => { if (t.agent === a.name && t.csat) csatScores.push(t.csat); }));
  const avgCSAT = csatScores.length ? csatScores.reduce((a, b) => a + b, 0) / csatScores.length : 0;

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
          <div style="width:26px;height:26px;border-radius:50%;background:var(--ink);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;color:#fff;flex-shrink:0;${a.active?'':'opacity:.5'}">${a.initials}</div>
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

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-breadcrumb">
          <span data-action="roles.closeAgents">Roles</span>
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
          <div style="width:54px;height:54px;border-radius:var(--r2);background:var(--ink);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6l8-4z" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:20px;font-weight:700;color:var(--ink);letter-spacing:-.02em">${role}</div>
            <div style="font-size:13px;color:var(--ink3);margin-top:6px">${list.length} member${list.length===1?'':'s'}${role==='Admin'?' · Protected role':''}</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
          <div class="r-tile"><div class="r-tile-n" style="color:var(--ink)">${list.length}</div><div class="r-tile-l" style="color:var(--ink3)">Members</div></div>
          <div class="r-tile" style="border-color:rgba(33,122,70,0.3);background:var(--green-lt)"><div class="r-tile-n" style="color:var(--green)">${activeN}</div><div class="r-tile-l" style="color:var(--green)">Active</div></div>
          <div class="r-tile" style="border-color:rgba(11,114,133,0.3);background:var(--cyan-lt)"><div class="r-tile-n" style="color:var(--cyan)">${avgLoad}</div><div class="r-tile-l" style="color:var(--cyan)">Avg open load</div></div>
          <div class="r-tile" style="border-color:rgba(154,107,10,0.3);background:var(--amber-lt)"><div class="r-tile-n" style="color:var(--amber)">${csatScores.length?avgCSAT.toFixed(1):'—'}</div><div class="r-tile-l" style="color:var(--amber)">Team CSAT</div></div>
        </div>

        ${list.length ? `
        <div class="card" style="margin-bottom:16px">
          <div class="card-title">Workload distribution</div>
          ${memberLoad.map(m => `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px;cursor:pointer" data-action="roles.openAgent" data-name="${window.escAttr(m.a.name)}">
              <div style="width:22px;height:22px;border-radius:50%;background:var(--ink);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:#fff;flex-shrink:0;${m.a.active?'':'opacity:.5'}">${m.a.initials}</div>
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
  showModal('Rename role', `
    <div class="form-row">
      <label class="form-label">New name</label>
      <input class="form-input" id="rn-name" value="${String(oldName).replace(/"/g,'&quot;')}"/>
    </div>
  `, async () => {
    const newName = document.getElementById('rn-name').value.trim();
    if (!newName || newName === oldName) { closeModal(); return; }
    if (ROLES.includes(newName)) return; // duplicate guard
    const uuid = getRoleUuid(oldName);
    if (uuid) {
      try { await apiPatch(`/api/v1/roles/${uuid}`, { name: newName }); }
      catch (err) { alert(`Couldn't rename: ${err?.message || err}`); return; }
      renameRoleUuid(oldName, newName);
    }
    const i = ROLES.indexOf(oldName);
    if (i >= 0) ROLES[i] = newName;
    AGENTS.forEach(a => { if (a.role === oldName) a.role = newName; });
    if (ROLES_VIEW_AGENTS === oldName) setRolesViewAgents(newName);
    closeModal(); renderPage('roles');
  }, 'Rename');
}

function openRoleAgents(role) { setRolesViewAgents(role); renderPage('roles'); }
function closeRoleAgents()    { setRolesViewAgents(null); renderPage('roles'); }

export async function reassignAgent(name, newRole) {
  if (!window.isAdmin()) return;
  const a = AGENTS.find(x => x.name === name);
  if (!a || !ROLES.includes(newRole)) return;
  if (a.userId) {
    const roleUuid = getRoleUuid(newRole);
    if (!roleUuid) { alert(`Couldn't find role "${newRole}"`); return; }
    try { await apiPatch(`/api/v1/agents/${a.userId}`, { role_id: roleUuid }); }
    catch (err) { alert(`Couldn't reassign: ${err?.message || err}`); return; }
  }
  a.role = newRole;
  renderPage(CURRENT_PAGE);
}

export async function setAgentActive(name, active) {
  if (!window.isAdmin()) return;
  const a = AGENTS.find(x => x.name === name);
  if (!a) return;
  if (a.userId) {
    try { await apiPatch(`/api/v1/agents/${a.userId}`, { active }); }
    catch (err) { alert(`Couldn't update status: ${err?.message || err}`); return; }
  }
  a.active = active;
  renderPage(CURRENT_PAGE);
}

export function deleteAgentPrompt(name) {
  if (!window.isAdmin()) return;
  showModal('Delete agent', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently remove <strong style="color:var(--ink)">${name}</strong>? Tickets currently assigned to them will keep the historical assignment.</div>`, async () => {
    const a = AGENTS.find(x => x.name === name);
    if (a?.userId) {
      try { await apiDelete(`/api/v1/agents/${a.userId}`); }
      catch (err) { alert(`Couldn't delete: ${err?.message || err}`); return; }
    }
    const i = AGENTS.findIndex(x => x.name === name);
    if (i >= 0) AGENTS.splice(i, 1);
    if (AGENT_SELECTED === name) setAgentSelected(null);
    closeModal(); renderPage(CURRENT_PAGE);
  }, 'Delete');
}

function addAgentToRolePrompt(role) {
  if (!window.isAdmin()) return;
  showModal(`Add agent to ${role}`, `
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
    closeModal(); renderPage('roles');
  }, 'Add');
}

function addRolePrompt() {
  if (!window.isAdmin()) return;
  showModal('New role', `
    <div class="form-row"><label class="form-label">Role name</label><input class="form-input" id="nr-name" placeholder="e.g. Compliance Officer"/></div>
  `, async () => {
    const name = document.getElementById('nr-name').value.trim();
    if (!name || ROLES.includes(name)) return;
    if (rolesApiBacked()) {
      let resp;
      try { resp = await apiPost('/api/v1/roles', { name }); }
      catch (err) { alert(`Couldn't create role: ${err?.message || err}`); return; }
      setRoleUuid(resp.role.name, resp.role.id);
      setRoleCanManageCF(resp.role.name, resp.role.can_manage_custom_fields);
    }
    ROLES.push(name);
    closeModal(); renderPage('roles');
  }, 'Create');
}

// Toggle a role's custom-field-management capability. Admin-only; the Admin
// role itself is locked on (admins always manage). Optimistic with rollback.
async function toggleRoleCustomFields(role, val) {
  if (!window.isAdmin() || role === 'Admin') return;
  const prev = getRoleCanManageCF(role);
  setRoleCanManageCF(role, val);
  const uuid = getRoleUuid(role);
  if (uuid) {
    try { await apiPatch(`/api/v1/roles/${uuid}`, { can_manage_custom_fields: val }); }
    catch (err) {
      setRoleCanManageCF(role, prev);
      alert(`Couldn't update: ${err?.message || err}`);
      renderPage('roles');
    }
  }
}

function deleteRolePrompt(role) {
  if (!window.isAdmin() || role === 'Admin') return;
  const inUse = AGENTS.filter(a => a.role === role).length;
  if (inUse > 0) {
    showModal('Cannot delete role', `<div style="font-size:13px;color:var(--ink2);line-height:1.6"><strong style="color:var(--ink)">${inUse}</strong> agent${inUse===1?' is':'s are'} still assigned to <strong style="color:var(--ink)">${role}</strong>. Reassign them to another role first.</div>`, null, null);
    return;
  }
  showModal('Delete role', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete the <strong style="color:var(--ink)">${role}</strong> role?</div>`, async () => {
    const uuid = getRoleUuid(role);
    if (uuid) {
      try { await apiDelete(`/api/v1/roles/${uuid}`); }
      catch (err) { alert(`Couldn't delete: ${err?.message || err}`); return; }
      clearRoleUuid(role);
    }
    const i = ROLES.indexOf(role);
    if (i >= 0) ROLES.splice(i, 1);
    closeModal(); renderPage('roles');
  }, 'Delete');
}

registerActions({
  'roles.openAgents':    (ds) => openRoleAgents(ds.role),
  'roles.closeAgents':   () => closeRoleAgents(),
  'roles.addRole':       () => addRolePrompt(),
  'roles.deleteRole':    (ds) => deleteRolePrompt(ds.role),
  'roles.rename':        (ds) => renameRolePrompt(ds.role),
  'roles.addAgent':      (ds) => addAgentToRolePrompt(ds.role),
  'roles.openAgent':     (ds) => openAgentFromDash(ds.name),
  'roles.setActive':     (ds) => setAgentActive(ds.name, ds.active === 'true'),
  'roles.deleteAgent':   (ds) => deleteAgentPrompt(ds.name),
});

registerChangeActions({
  'roles.toggleCustomFields':  (ds, el) => toggleRoleCustomFields(ds.role, el.checked),
  'roles.reassign':            (ds, el) => reassignAgent(ds.name, el.value),
});
