// ─── Assignment rules ────────────────────────────────────────────────────────
// Evaluates an ordered list of rules against a ticket and assigns an agent
// based on the first matching rule's policy (specific-agent / round-robin /
// least-busy). Also owns the agent out-of-office (OOO) helpers, since
// round-robin and least-busy modes need to skip agents on leave.
//
// External reaches (interim, via window): isAdmin, escHtml, escAttr,
// renderPage — all still in app.js. openTicket, showModal / closeModal are
// direct ES imports from core/modal.js.
//
// No window-bridge namespace spread: the page's own inline on*= handlers are
// delegated as ar.* actions (bottom of file). showAgentOOOModal (agents +
// profile) and runAssignmentRulesOnTicket (detail.js td.runRules) are consumed
// via direct ES import; renderAssignmentRules is the router entry. Two exports
// — isAgentOOO and applyAssignmentRules — are still reached via window.X from
// OTHER modules' render code (isAgentOOO in agents/profile/quick-switcher,
// applyAssignmentRules in inbox/portal), so they're kept as explicit single-fn
// entries on the app.js bridge until a follow-up lifts those callers to direct
// imports.
//
// logTicketEvent is imported from core/activity-log.js (already extracted).
//
// AGENTS, TICKETS, CUSTOMERS, ASSIGN_RULES, ASSIGN_RULES_RR_INDEX come from
// data.js via the global lexical env; SESSION, TICKET_SELECTED_IDS,
// CURRENT_TICKET, CURRENT_PAGE, AR_FILTER come from core/state.js the same way.

import { logTicketEvent } from '../core/activity-log.js';
import { openTicket } from './detail.js';
import { apiPost, apiPatch, apiDelete } from '../core/api-client.js';
import { showModal, closeModal } from '../core/modal.js';
import { registerActions, registerChangeActions } from '../core/event-delegation.js';

function arApiBacked() {
  return ASSIGN_RULES.some((r) => r._uuid);
}

// Resolve an agent display name → user UUID via the loaded AGENTS array.
function userIdForAgent(name) {
  return AGENTS.find((a) => a.name === name)?.userId || null;
}

// Map a client-shape assignment to the API payload (agent_user_id or
// team_user_ids). Returns null if a required user can't be resolved
// (caller surfaces the error to the user).
function assignmentClientToApi(a) {
  if (!a) return null;
  if (a.mode === 'specific-agent') {
    const uid = userIdForAgent(a.agent);
    if (!uid) return null;
    return { mode: 'specific-agent', agent_user_id: uid };
  }
  const teamIds = (a.team || []).map(userIdForAgent).filter(Boolean);
  if (teamIds.length === 0) return null;
  return { mode: a.mode, team_user_ids: teamIds };
}

function arMapResponse(r) {
  // Build a userByUuid map locally for the single response.
  const userByUuid = Object.fromEntries(AGENTS.map((a) => [a.userId, a]));
  let assignment;
  if (r.assignment?.mode === 'specific-agent') {
    assignment = { mode: 'specific-agent', agent: userByUuid[r.assignment.agent_user_id]?.name || '' };
  } else {
    assignment = {
      mode: r.assignment?.mode || 'round-robin',
      team: (r.assignment?.team_user_ids || []).map((uid) => userByUuid[uid]?.name).filter(Boolean),
    };
  }
  return {
    _uuid:       r.id,
    id:          r.display_id,
    name:        r.name,
    priority:    r.priority,
    status:      r.status,
    conditions:  r.conditions,
    assignment,
    matchCount:  r.match_count || 0,
    lastMatchAt: r.last_match_at ? String(r.last_match_at).slice(0, 10) : null,
  };
}

function arNextId() {
  const max = Math.max(0, ...ASSIGN_RULES.map(r => parseInt((r.id||'').split('-')[1] || '0', 10)));
  return `AR-${String(max + 1).padStart(3, '0')}`;
}

function arRuleMatches(rule, t) {
  if (rule.status !== 'active') return false;
  const c = rule.conditions || {};
  if (c.priority && c.priority !== 'all' && c.priority !== t.priority) return false;
  if (c.category && c.category !== 'all' && c.category !== t.category) return false;
  if (c.vip && c.vip !== 'all') {
    const cust = CUSTOMERS.find(x => x.id === t.customerId);
    if (!cust || cust.vip !== c.vip) return false;
  }
  return true;
}

function arPickAgent(rule) {
  const a = rule.assignment || {};
  if (a.mode === 'specific-agent') return a.agent || null;
  // Round-robin and least-busy modes filter out agents who are currently OOO so
  // tickets don't queue up against someone on leave.
  if (a.mode === 'round-robin') {
    const team = (a.team || []).filter(Boolean);
    if (!team.length) return null;
    const available = team.filter(name => !isAgentOOO(name));
    if (!available.length) return null;
    // Walk forward through the FULL team starting at the stored cursor; pick
    // the first available agent. Storing the cursor against `team.length`
    // (not `available.length`) keeps the cycle stable when an OOO agent
    // returns and rejoins the rotation mid-cycle.
    const len = team.length;
    let idx = (ASSIGN_RULES_RR_INDEX[rule.id] || 0) % len;
    let pick = null;
    for (let i = 0; i < len; i++) {
      const candidate = team[(idx + i) % len];
      if (available.includes(candidate)) { pick = candidate; idx = (idx + i); break; }
    }
    if (!pick) return null;
    ASSIGN_RULES_RR_INDEX[rule.id] = (idx + 1) % len;
    return pick;
  }
  if (a.mode === 'least-busy') {
    const team = (a.team || []).filter(Boolean);
    if (!team.length) return null;
    const available = team.filter(name => !isAgentOOO(name));
    if (!available.length) return null;
    // Pick the available team member with the fewest open/escalated tickets.
    const counts = available.map(name => ({
      name,
      n: TICKETS.filter(t => t.agent === name && (t.status === 'open' || t.status === 'escalated')).length,
    }));
    counts.sort((a, b) => a.n - b.n);
    return counts[0].name;
  }
  return null;
}

// ─── Agent out-of-office ────────────────────────────────────────────────────
// Agents flag themselves OOO with a from/to date range and an optional note.
// Assignment rules (round-robin and least-busy) skip OOO agents so tickets
// don't queue up against someone on leave. Direct "specific agent" rules and
// manual assignment still allow assigning to an OOO agent (an admin may
// intentionally page them) but the agent's tile shows the OOO state clearly.
export function isAgentOOO(name, atDate) {
  const a = AGENTS.find(x => x.name === name);
  if (!a || !a.oooFrom) return false;
  // Use local date — `<input type="date">` returns local YYYY-MM-DD, so
  // comparing in the same frame avoids a half-day off-by-one around midnight UTC.
  const d = atDate ? new Date(atDate) : new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return today >= a.oooFrom && (!a.oooTo || today <= a.oooTo);
}

// Auth guard: only the agent themselves or an admin may mutate OOO state.
// Surface buttons gate this too, but checking on the mutators keeps it safe
// against console / macro / future automation callers.
function canEditAgentOOO(name) {
  return SESSION && (SESSION.name === name || window.isAdmin());
}

async function setAgentOOO(name, from, to, note) {
  if (!canEditAgentOOO(name)) return;
  const a = AGENTS.find(x => x.name === name);
  if (!a) return;
  const trimmedNote = (note || '').trim() || null;
  if (a.userId) {
    try {
      await apiPatch(`/api/v1/agents/${a.userId}`, {
        ooo_from: from || null,
        ooo_to:   from ? (to || null) : null,
        ooo_note: from ? trimmedNote : null,
      });
    } catch (err) { alert(`Couldn't update OOO: ${err?.message || err}`); return; }
  }
  if (!from) { delete a.oooFrom; delete a.oooTo; delete a.oooNote; return; }
  a.oooFrom = from;
  a.oooTo = to || null;
  a.oooNote = trimmedNote;
}

async function clearAgentOOO(name) {
  if (!canEditAgentOOO(name)) return;
  await setAgentOOO(name, null);
}

export function showAgentOOOModal(name) {
  if (!canEditAgentOOO(name)) {
    alert('Only the agent themselves or an admin can edit OOO status.');
    return;
  }
  const a = AGENTS.find(x => x.name === name);
  if (!a) return;
  const today = new Date().toISOString().slice(0, 10);
  showModal(`Out of office · ${window.escHtml(name)}`, `
    <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">While ${window.escHtml(a.name.split(' ')[0])} is OOO, the assignment rules engine skips them in round-robin and least-busy modes. Direct assignment still works — admins may intentionally page someone on leave.</div>
    <div class="form-grid">
      <div class="form-row"><label class="form-label">From</label><input class="form-input" type="date" id="ooo-from" value="${window.escAttr(a.oooFrom || today)}"/></div>
      <div class="form-row"><label class="form-label">Until</label><input class="form-input" type="date" id="ooo-to" value="${window.escAttr(a.oooTo || '')}"/></div>
    </div>
    <div class="form-row"><label class="form-label">Auto-reply note (optional)</label>
      <input class="form-input" id="ooo-note" value="${window.escAttr(a.oooNote || '')}" placeholder="e.g. Annual leave — back Friday"/>
    </div>
    ${a.oooFrom ? `<div style="margin-top:14px;text-align:right"><button class="btn btn-sm btn-danger" data-action="ar.clearOOO" data-name="${window.escAttr(name)}">Clear OOO</button></div>` : ''}
  `, async () => {
    const from = document.getElementById('ooo-from').value;
    const to   = document.getElementById('ooo-to').value;
    const note = document.getElementById('ooo-note').value;
    if (!from) { alert('Pick a start date.'); return; }
    if (to && to < from) { alert('End date must be on or after the start date.'); return; }
    await setAgentOOO(name, from, to, note);
    closeModal();
    window.renderPage(CURRENT_PAGE);
  }, 'Save');
}

export function applyAssignmentRules(t) {
  if (!t) return null;
  const ordered = [...ASSIGN_RULES].sort((a, b) => (a.priority || 99) - (b.priority || 99));
  for (const rule of ordered) {
    if (!arRuleMatches(rule, t)) continue;
    const agent = arPickAgent(rule);
    if (!agent) continue;
    if (t.agent !== agent) {
      logTicketEvent(t.id, 'assign', `Assigned by rule ${rule.id} (${rule.name}): ${t.agent || 'Unassigned'} → ${agent}`);
    }
    t.agent = agent;
    rule.matchCount = (rule.matchCount || 0) + 1;
    rule.lastMatchAt = new Date().toISOString().slice(0, 10);
    return rule;
  }
  return null;
}

export async function runAssignmentRulesOnTicket(id) {
  const t = TICKETS.find(x => x.id === id);
  if (!t) return;
  // API path: the server runs the engine, picks an agent, persists.
  // On match, mirror the new assignee + rule bookkeeping into local
  // state so the UI updates without a refresh.
  if (t._uuid) {
    let resp;
    try { resp = await apiPost(`/api/v1/tickets/${t._uuid}/apply-rules`, {}); }
    catch (err) { alert(`Couldn't apply rules: ${err?.message || err}`); return; }
    if (!resp.matched) { alert('No active rule matched this ticket.'); return; }
    const userByUuid = Object.fromEntries(AGENTS.map((a) => [a.userId, a]));
    const oldAgent = t.agent || 'Unassigned';
    const newAgent = userByUuid[resp.ticket.assigned_user_id]?.name || '';
    if (newAgent && newAgent !== oldAgent) {
      logTicketEvent(id, 'assign', `Assigned by rule ${resp.rule.name}: ${oldAgent} → ${newAgent}`);
      t.agent = newAgent;
    }
    // Bookkeeping for the matched rule mirrors the server's bump.
    const localRule = ASSIGN_RULES.find(r => r._uuid === resp.rule.id);
    if (localRule) {
      localRule.matchCount = (localRule.matchCount || 0) + 1;
      localRule.lastMatchAt = new Date().toISOString().slice(0, 10);
    }
    if (CURRENT_TICKET === id) openTicket(id);
    else window.renderPage(CURRENT_PAGE || 'tickets');
    return;
  }
  // Demo persona — keep the local engine.
  const rule = applyAssignmentRules(t);
  if (!rule) { alert('No active rule matched this ticket.'); return; }
  if (CURRENT_TICKET === id) openTicket(id);
  else window.renderPage(CURRENT_PAGE || 'tickets');
}

async function bulkApplyAssignmentRules() {
  if (TICKET_SELECTED_IDS.size === 0) return;
  const ids = [...TICKET_SELECTED_IDS];
  const apiBacked = ids.some(id => TICKETS.find(t => t.id === id)?._uuid);
  let matched = 0;
  if (apiBacked) {
    // Fan out parallel API calls. Mirror result into local state per ticket.
    const userByUuid = Object.fromEntries(AGENTS.map((a) => [a.userId, a]));
    const results = await Promise.allSettled(ids.map(async (id) => {
      const t = TICKETS.find(x => x.id === id);
      if (!t?._uuid) return false;
      const resp = await apiPost(`/api/v1/tickets/${t._uuid}/apply-rules`, {});
      if (!resp.matched) return false;
      const newAgent = userByUuid[resp.ticket.assigned_user_id]?.name || '';
      if (newAgent) {
        if (t.agent !== newAgent) logTicketEvent(id, 'assign', `Assigned by rule ${resp.rule.name}: ${t.agent || 'Unassigned'} → ${newAgent}`);
        t.agent = newAgent;
      }
      const localRule = ASSIGN_RULES.find(r => r._uuid === resp.rule.id);
      if (localRule) {
        localRule.matchCount = (localRule.matchCount || 0) + 1;
        localRule.lastMatchAt = new Date().toISOString().slice(0, 10);
      }
      return true;
    }));
    matched = results.filter(r => r.status === 'fulfilled' && r.value).length;
  } else {
    ids.forEach(id => {
      const t = TICKETS.find(x => x.id === id);
      if (t && applyAssignmentRules(t)) matched++;
    });
  }
  TICKET_SELECTED_IDS.clear();
  window.renderPage('tickets');
  alert(matched ? `Assignment rules matched ${matched} ticket${matched===1?'':'s'}.` : 'No active rule matched any ticket in the selection.');
}

async function arToggle(id, active) {
  if (!window.isAdmin()) return;
  const r = ASSIGN_RULES.find(x => x.id === id);
  if (!r) return;
  const next = active ? 'active' : 'inactive';
  if (r._uuid) {
    try { await apiPatch(`/api/v1/assign-rules/${r._uuid}`, { status: next }); }
    catch (err) { alert(`Couldn't toggle: ${err?.message || err}`); return; }
  }
  r.status = next;
}

function arConditionsSummary(c) {
  const bits = [];
  if (c.priority && c.priority !== 'all') bits.push(`priority=<strong>${window.escHtml(c.priority)}</strong>`);
  if (c.category && c.category !== 'all') bits.push(`category=<strong>${window.escHtml(c.category)}</strong>`);
  if (c.vip && c.vip !== 'all') bits.push(`VIP=<strong>${window.escHtml(c.vip)}</strong>`);
  return bits.length ? bits.join(' · ') : '<span style="color:var(--ink3)">any ticket</span>';
}

function arAssignmentSummary(a) {
  if (!a) return '<span style="color:var(--ink3)">—</span>';
  if (a.mode === 'specific-agent') return `→ <strong>${window.escHtml(a.agent || '—')}</strong>`;
  if (a.mode === 'round-robin')    return `↻ round-robin · ${(a.team||[]).map(window.escHtml).join(', ') || '—'}`;
  if (a.mode === 'least-busy')     return `↧ least-busy · ${(a.team||[]).map(window.escHtml).join(', ') || '—'}`;
  return window.escHtml(a.mode);
}

function arFormBody(r) {
  const esc = s => String(s||'').replace(/"/g,'&quot;');
  const cats = ['all', ...new Set(TICKETS.map(t => t.category))];
  const vipOpts = ['all','Gold','Silver','Standard'];
  const c = r?.conditions || { priority:'all', category:'all', vip:'all' };
  const a = r?.assignment || { mode:'round-robin', team:[] };
  const teamCsv = (a.team || []).join(', ');
  return `
    <div class="form-row"><label class="form-label">Name</label><input class="form-input" id="ar-name" value="${esc(r?.name)}" placeholder="e.g. Urgent · Billing → Sofia"/></div>
    <div class="form-grid">
      <div class="form-row"><label class="form-label">Priority (lower wins)</label><input class="form-input" type="number" id="ar-priority" value="${r?.priority ?? 50}" min="1" max="999"/></div>
      <div class="form-row"><label class="form-label">Status</label>
        <select class="form-input" id="ar-status">
          <option value="active"   ${(r?.status || 'active')==='active'?'selected':''}>Active</option>
          <option value="inactive" ${r?.status==='inactive'?'selected':''}>Inactive</option>
        </select>
      </div>
    </div>
    <div style="font-size:11px;font-weight:600;color:var(--ink2);text-transform:uppercase;letter-spacing:.06em;margin:14px 0 8px">When</div>
    <div class="form-grid">
      <div class="form-row"><label class="form-label">Priority</label>
        <select class="form-input" id="ar-cond-priority">${['all','urgent','high','normal','low'].map(p=>`<option value="${p}" ${c.priority===p?'selected':''}>${p==='all'?'Any':p}</option>`).join('')}</select>
      </div>
      <div class="form-row"><label class="form-label">Category</label>
        <select class="form-input" id="ar-cond-category">${cats.map(x=>`<option value="${window.escAttr(x)}" ${c.category===x?'selected':''}>${x==='all'?'Any':window.escHtml(x)}</option>`).join('')}</select>
      </div>
      <div class="form-row"><label class="form-label">VIP tier</label>
        <select class="form-input" id="ar-cond-vip">${vipOpts.map(v=>`<option value="${v}" ${c.vip===v?'selected':''}>${v==='all'?'Any':v}</option>`).join('')}</select>
      </div>
    </div>
    <div style="font-size:11px;font-weight:600;color:var(--ink2);text-transform:uppercase;letter-spacing:.06em;margin:14px 0 8px">Then assign</div>
    <div class="form-row"><label class="form-label">Mode</label>
      <select class="form-input" id="ar-mode" data-change-action="ar.modeChanged">
        <option value="specific-agent" ${a.mode==='specific-agent'?'selected':''}>Specific agent</option>
        <option value="round-robin"    ${a.mode==='round-robin'?'selected':''}>Round-robin (cycle through team)</option>
        <option value="least-busy"     ${a.mode==='least-busy'?'selected':''}>Least-busy (fewest open tickets)</option>
      </select>
    </div>
    <div class="form-row" id="ar-agent-row" style="display:${a.mode==='specific-agent'?'block':'none'}">
      <label class="form-label">Agent</label>
      <select class="form-input" id="ar-agent">${AGENTS.map(ag=>`<option value="${window.escAttr(ag.name)}" ${a.agent===ag.name?'selected':''}>${window.escHtml(ag.name)}</option>`).join('')}</select>
    </div>
    <div class="form-row" id="ar-team-row" style="display:${a.mode==='specific-agent'?'none':'block'}">
      <label class="form-label">Team (comma-separated agent names)</label>
      <input class="form-input" id="ar-team" value="${esc(teamCsv)}" placeholder="Emma Clarke, Sofia Reyes"/>
      <div style="font-size:11px;color:var(--ink3);margin-top:4px">Round-robin cycles through the team in order. Least-busy picks the agent with fewest open + escalated tickets.</div>
    </div>`;
}

function arModeChanged(mode) {
  const agentRow = document.getElementById('ar-agent-row');
  const teamRow  = document.getElementById('ar-team-row');
  if (agentRow) agentRow.style.display = mode === 'specific-agent' ? 'block' : 'none';
  if (teamRow)  teamRow.style.display  = mode === 'specific-agent' ? 'none' : 'block';
}

function arReadForm() {
  const mode = document.getElementById('ar-mode').value;
  const assignment = { mode };
  if (mode === 'specific-agent') {
    assignment.agent = document.getElementById('ar-agent').value;
  } else {
    const csv = document.getElementById('ar-team').value;
    assignment.team = csv.split(',').map(s => s.trim()).filter(Boolean);
  }
  return {
    name: document.getElementById('ar-name').value.trim(),
    priority: parseInt(document.getElementById('ar-priority').value, 10) || 50,
    status: document.getElementById('ar-status').value,
    conditions: {
      priority: document.getElementById('ar-cond-priority').value,
      category: document.getElementById('ar-cond-category').value,
      vip:      document.getElementById('ar-cond-vip').value,
    },
    assignment,
  };
}

function arNew() {
  if (!window.isAdmin()) return;
  showModal('New assignment rule', arFormBody(null), async () => {
    const data = arReadForm();
    if (!data.name) { alert('Name is required.'); return; }
    if (data.assignment.mode === 'specific-agent' && !data.assignment.agent) { alert('Pick an agent.'); return; }
    if (data.assignment.mode !== 'specific-agent' && !(data.assignment.team || []).length) { alert('Team is required.'); return; }
    if (arApiBacked()) {
      const apiAssignment = assignmentClientToApi(data.assignment);
      if (!apiAssignment) { alert('Could not resolve agent(s) to user IDs.'); return; }
      let resp;
      try {
        resp = await apiPost('/api/v1/assign-rules', {
          name:        data.name,
          priority:    data.priority,
          status:      data.status,
          conditions:  data.conditions,
          assignment:  apiAssignment,
        });
      } catch (err) { alert(`Couldn't create: ${err?.message || err}`); return; }
      ASSIGN_RULES.push(arMapResponse(resp.assign_rule));
    } else {
      ASSIGN_RULES.push({ id: arNextId(), matchCount: 0, lastMatchAt: null, ...data });
    }
    closeModal(); window.renderPage('assignment-rules');
  }, 'Create');
}

function arEdit(id) {
  if (!window.isAdmin()) return;
  const r = ASSIGN_RULES.find(x => x.id === id); if (!r) return;
  showModal('Edit rule · ' + r.id, arFormBody(r), async () => {
    const data = arReadForm();
    if (!data.name) { alert('Name is required.'); return; }
    if (data.assignment.mode === 'specific-agent' && !data.assignment.agent) { alert('Pick an agent.'); return; }
    if (data.assignment.mode !== 'specific-agent' && !(data.assignment.team || []).length) { alert('Team is required.'); return; }
    if (r._uuid) {
      const apiAssignment = assignmentClientToApi(data.assignment);
      if (!apiAssignment) { alert('Could not resolve agent(s) to user IDs.'); return; }
      try {
        await apiPatch(`/api/v1/assign-rules/${r._uuid}`, {
          name:        data.name,
          priority:    data.priority,
          status:      data.status,
          conditions:  data.conditions,
          assignment:  apiAssignment,
        });
      } catch (err) { alert(`Couldn't save: ${err?.message || err}`); return; }
    }
    Object.assign(r, data);
    delete ASSIGN_RULES_RR_INDEX[r.id];
    closeModal(); window.renderPage('assignment-rules');
  }, 'Save');
}

function arDelete(id) {
  if (!window.isAdmin()) return;
  const r = ASSIGN_RULES.find(x => x.id === id); if (!r) return;
  showModal('Delete rule', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${window.escHtml(r.name)}</strong>?</div>`, async () => {
    if (r._uuid) {
      try { await apiDelete(`/api/v1/assign-rules/${r._uuid}`); }
      catch (err) { alert(`Couldn't delete: ${err?.message || err}`); return; }
    }
    const i = ASSIGN_RULES.findIndex(x => x.id === id);
    if (i >= 0) ASSIGN_RULES.splice(i, 1);
    delete ASSIGN_RULES_RR_INDEX[id];
    closeModal(); window.renderPage('assignment-rules');
  }, 'Delete');
}

export function renderAssignmentRules() {
  const admin = window.isAdmin();
  let list = [...ASSIGN_RULES].sort((a, b) => (a.priority || 99) - (b.priority || 99));
  if (AR_FILTER === 'active')   list = list.filter(r => r.status === 'active');
  if (AR_FILTER === 'inactive') list = list.filter(r => r.status === 'inactive');
  const total = ASSIGN_RULES.length;
  const activeN = ASSIGN_RULES.filter(r => r.status === 'active').length;
  const totalMatches = ASSIGN_RULES.reduce((s, r) => s + (r.matchCount || 0), 0);
  const top = [...ASSIGN_RULES].sort((a,b)=>(b.matchCount||0)-(a.matchCount||0))[0];

  const rows = list.map(r => `
    <tr>
      <td style="font-family:'DM Mono',monospace;font-size:12px;text-align:center">${r.priority || 50}</td>
      <td><strong>${window.escHtml(r.name)}</strong><div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);margin-top:2px">${window.escHtml(r.id)}</div></td>
      <td style="font-size:11px;color:var(--ink2)">${arConditionsSummary(r.conditions || {})}</td>
      <td style="font-size:11px;color:var(--ink2)">${arAssignmentSummary(r.assignment)}</td>
      <td style="font-family:'DM Mono',monospace;font-size:12px">${r.matchCount || 0}</td>
      <td style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3)">${window.escHtml(r.lastMatchAt || '—')}</td>
      <td style="text-align:center">
        <label class="toggle">
          <input type="checkbox" ${r.status==='active'?'checked':''} ${admin?'':'disabled'} data-change-action="ar.toggle" data-id="${window.escAttr(r.id)}">
          <span class="toggle-slider"></span>
        </label>
      </td>
      ${admin ? `<td style="text-align:right;white-space:nowrap">
        <button class="btn btn-sm" data-action="ar.edit" data-id="${window.escAttr(r.id)}">Edit</button>
        <button class="btn btn-sm btn-danger" data-action="ar.delete" data-id="${window.escAttr(r.id)}">Delete</button>
      </td>` : ''}
    </tr>`).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Assignment Rules</div>
        ${admin
          ? `<button class="btn btn-solid btn-sm" data-action="ar.new">+ New Rule</button>`
          : `<span style="font-size:11px;color:var(--ink3);font-style:italic">Read-only — admin access required to edit</span>`}
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Rules</div></div>
        <div class="kpi"><div class="kpi-n c-green">${activeN}</div><div class="kpi-l">Active</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${totalMatches}</div><div class="kpi-l">Total matches</div></div>
        <div class="kpi"><div class="kpi-n c-purple" style="font-size:18px;line-height:1.1">${top ? window.escHtml(top.name) : '—'}</div><div class="kpi-l">Most used ${top ? '· ' + (top.matchCount || 0) : ''}</div></div>
      </div>
      <div class="filter-bar">
        <span class="filter-label">Filter</span>
        <select class="filter-select" data-change-action="ar.setFilter">
          <option value="all"      ${AR_FILTER==='all'?'selected':''}>All rules</option>
          <option value="active"   ${AR_FILTER==='active'?'selected':''}>Active</option>
          <option value="inactive" ${AR_FILTER==='inactive'?'selected':''}>Inactive</option>
        </select>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${total}</span>
      </div>
      <div class="page-scroll">
        <table class="tbl">
          <thead><tr>
            <th style="width:50px;text-align:center">#</th><th>Rule</th><th>When</th><th>Then assign</th><th>Matches</th><th>Last match</th>
            <th style="text-align:center">Active</th>
            ${admin?'<th style="text-align:right">Actions</th>':''}
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${list.length===0 ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No rules match</div><div class="empty-line"></div></div>` : ''}
        <div style="margin-top:14px;font-size:11px;color:var(--ink3);line-height:1.5;padding:0 4px">Rules are evaluated in ascending priority order; the first matching active rule wins. Apply rules manually from the ticket sidebar (<strong style="color:var(--ink2)">Run rules</strong>) or to a selection from the bulk action bar. New tickets created with "Auto" assignment go through this engine.</div>
      </div>
    </div>`;
}

registerActions({
  'ar.new':      () => arNew(),
  'ar.edit':     (ds) => arEdit(ds.id),
  'ar.delete':   (ds) => arDelete(ds.id),
  // bulk "Run rules" button rendered by tickets/list.js
  'ar.bulkRun':  () => bulkApplyAssignmentRules(),
  // OOO modal "Clear OOO" button — await so the cleared state is reflected
  // before the re-render (matches the Save handler in showAgentOOOModal).
  'ar.clearOOO': async (ds) => { await clearAgentOOO(ds.name); closeModal(); window.renderPage(CURRENT_PAGE); },
});

registerChangeActions({
  'ar.modeChanged': (ds, el) => arModeChanged(el.value),
  'ar.toggle':      (ds, el) => arToggle(ds.id, el.checked),
  'ar.setFilter':   (ds, el) => { AR_FILTER = el.value; window.renderPage('assignment-rules'); },
});
