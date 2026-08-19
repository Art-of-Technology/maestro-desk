// ─── Channels ────────────────────────────────────────────────────────────────
// Where tickets enter the workspace — email inboxes, web forms, chat widgets,
// raw API endpoints. Each channel carries default routing (category + agent)
// plus a default PRIORITY — inbound email matched to the channel's address
// creates its ticket at that priority (complaint@ -> urgent), see
// api/src/lib/inbound-email.ts — a signature for outbound replies, and
// 30-day volume stats. Admins can add / edit / delete and toggle active
// state from the list, or click a row for the read-only detail view.
//
// Live workspaces (rows carry `_uuid` from bootstrap) persist through
// /api/v1/channels; the demo persona keeps the local in-memory mutations.
//
// Click/change handlers route through core/event-delegation.js as
// `data-action="ch.*"` / `data-change-action="ch.*"`. The toggle and
// actions cells use `data-action=""` to absorb row-click bubbling.
//
// External reaches (interim, via window): isAdmin, escHtml, escAttr — all
// still in app.js.

import { AGENTS, CATEGORIES, CHANNELS, TICKETS } from '../core/data.js';
import { CH_FILTER, CURRENT_PAGE, setChFilter } from '../core/state.js';
import { renderPage } from '../core/router.js';
import { registerActions, registerChangeActions } from '../core/event-delegation.js';
import { showModal, closeModal } from '../core/modal.js';
import { apiPost, apiPatch, apiDelete, getJwt } from '../core/api-client.js';

const CH_TYPES = [
  { v:'email',   l:'Email',     icon:'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="3" width="12" height="8" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M1.5 3.5L7 8l5.5-4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
  { v:'webform', l:'Web form',  icon:'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="2" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M3 5h8M3 7.5h8M3 10h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>' },
  { v:'chat',    l:'Chat',      icon:'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 3h10v6H7l-3 3v-3H2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' },
  { v:'api',     l:'API',       icon:'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 3l-3 4 3 4M9 3l3 4-3 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
];

// Priority options mirror the workspace-provisioned lookup (same hardcoded
// set every other priority select in the SPA uses — a hydrated PRIORITIES
// binding is a future improvement). '' = no default -> ticket lands 'normal'.
const CH_PRIORITIES = ['low', 'normal', 'high', 'urgent'];

function chTypeIcon(t) {
  const meta = CH_TYPES.find(x => x.v === t) || CH_TYPES[0];
  return meta.icon;
}
function chTypeLabel(t) {
  const meta = CH_TYPES.find(x => x.v === t);
  return meta ? meta.l : t;
}

// Live sessions (real JWT) persist through the API; the demo persona and
// the CI smokes have no session and keep their local-only mutations. Keyed
// off the session, NOT off CHANNELS rows carrying _uuid — a freshly
// provisioned live workspace has zero channels and must still POST.
function chApiBacked() {
  return !!getJwt();
}

// One channel write at a time: the modal's confirm can be double-clicked
// while the request is in flight (two POSTs = duplicate channels).
let chBusy = false;

// API row -> UI shape; mirrors the bootstrap CHANNELS mapping.
function chMapResponse(r) {
  return {
    _uuid:           r.id,
    id:              r.display_id,
    name:            r.name,
    type:            r.type,
    address:         r.address || '',
    status:          r.status,
    defaultCategory: r.default_category_key || 'all',
    defaultPriority: r.default_priority_key || '',
    defaultAgent:    r.default_agent_name || '',
    signature:       r.signature || '',
    volume30d:       r.volume_30d || 0,
  };
}

// Category KEY -> display label (live workspaces hydrate CATEGORIES; demo
// seeds use the label as the key, so falling back to the key is correct).
function chCatLabel(key) {
  return (CATEGORIES.find(x => x.key === key) || {}).label || key;
}

export function renderChannels() {
  const admin = window.isAdmin();
  let list = [...CHANNELS];
  if (CH_FILTER === 'active')   list = list.filter(c => c.status === 'active');
  if (CH_FILTER === 'inactive') list = list.filter(c => c.status === 'inactive');

  const total = CHANNELS.length;
  const activeN = CHANNELS.filter(c => c.status === 'active').length;
  const totalVolume = CHANNELS.reduce((s, c) => s + (c.volume30d || 0), 0);
  const types = new Set(CHANNELS.map(c => c.type)).size;

  const rows = list.map(c => `
    <tr data-action="ch.open" data-ch-id="${window.escAttr(c.id)}" style="cursor:pointer">
      <td class="bold">${c.id}</td>
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="color:var(--ink3);flex-shrink:0">${chTypeIcon(c.type)}</span>
          <span style="font-weight:500;color:var(--ink)">${window.escHtml(c.name)}</span>
        </div>
      </td>
      <td><span class="tag tag-neutral" style="font-size:10px;text-transform:capitalize">${chTypeLabel(c.type)}</span></td>
      <td style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink2);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(c.address)}</td>
      <td style="font-size:12px;color:var(--ink2)">${c.defaultPriority ? `<span class="tag tag-${window.escAttr(c.defaultPriority)}" style="font-size:10px;text-transform:capitalize;margin-right:6px">${window.escHtml(c.defaultPriority)}</span>` : ''}${c.defaultCategory === 'all' ? '<span style="color:var(--ink3)">Any</span>' : window.escHtml(chCatLabel(c.defaultCategory))}${c.defaultAgent ? ` · ${window.escHtml(c.defaultAgent)}` : ''}</td>
      <td style="font-family:'DM Mono',monospace;font-size:12px">${c.volume30d || 0}</td>
      <td style="text-align:center" data-action="">
        <label class="toggle"><input type="checkbox" ${c.status==='active'?'checked':''} ${admin?'':'disabled'} data-change-action="ch.toggle" data-ch-id="${window.escAttr(c.id)}"><span class="toggle-slider"></span></label>
      </td>
      ${admin ? `<td style="text-align:right;white-space:nowrap" data-action="">
        <button class="btn btn-sm" data-action="ch.edit" data-ch-id="${window.escAttr(c.id)}">Edit</button>
        <button class="btn btn-sm btn-danger" data-action="ch.delete" data-ch-id="${window.escAttr(c.id)}">Delete</button>
      </td>` : ''}
    </tr>`).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Channels</div>
        ${admin ? `<button class="btn btn-solid btn-sm" data-action="ch.new">+ New Channel</button>` : `<span style="font-size:11px;color:var(--ink3);font-style:italic">Read-only</span>`}
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Channels</div></div>
        <div class="kpi"><div class="kpi-n c-green">${activeN}</div><div class="kpi-l">Active</div></div>
        <div class="kpi"><div class="kpi-n c-purple">${totalVolume}</div><div class="kpi-l">Volume (30d)</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${types}</div><div class="kpi-l">Types</div></div>
      </div>
      <div class="filter-bar">
        <span class="filter-label">Filter</span>
        <select class="filter-select" data-change-action="ch.setFilter">
          <option value="all"      ${CH_FILTER==='all'?'selected':''}>All channels</option>
          <option value="active"   ${CH_FILTER==='active'?'selected':''}>Active</option>
          <option value="inactive" ${CH_FILTER==='inactive'?'selected':''}>Inactive</option>
        </select>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${total}</span>
      </div>
      <div class="page-scroll">
        <table class="tbl">
          <thead><tr>
            <th>ID</th><th>Name</th><th>Type</th><th>Address</th><th>Routing</th><th>Volume 30d</th>
            <th style="text-align:center">Active</th>
            ${admin?'<th style="text-align:right">Actions</th>':''}
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${list.length===0 ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No channels match</div><div class="empty-line"></div></div>` : ''}
        <div style="margin-top:14px;font-size:11px;color:var(--ink3);line-height:1.5">Channels define how tickets enter the workspace. Click a row for full settings (signature, routing rules, last sync). Volume figures are the last 30 days of inbound tickets attributed to the channel.</div>
      </div>
    </div>`;
}

function openChannel(id) {
  const c = CHANNELS.find(x => x.id === id); if (!c) return;
  showModal(`${c.name} (${c.id})`, `
    <div class="form-grid">
      <div class="form-row"><label class="form-label">Type</label><div style="font-size:13px;color:var(--ink);padding:9px 12px;background:var(--off2);border:1px solid var(--rule);border-radius:var(--r);text-transform:capitalize">${chTypeLabel(c.type)}</div></div>
      <div class="form-row"><label class="form-label">Status</label><div style="font-size:13px;padding:9px 12px;background:var(--off2);border:1px solid var(--rule);border-radius:var(--r);text-transform:capitalize"><span class="tag ${c.status==='active'?'tag-resolved':'tag-pending'}">${c.status}</span></div></div>
    </div>
    <div class="form-row"><label class="form-label">Address</label><div style="font-family:'DM Mono',monospace;font-size:12px;color:var(--ink);padding:9px 12px;background:var(--off2);border:1px solid var(--rule);border-radius:var(--r)">${window.escHtml(c.address)}</div></div>
    <div class="form-grid">
      <div class="form-row"><label class="form-label">Default category</label><div style="font-size:13px;color:var(--ink);padding:9px 12px;background:var(--off2);border:1px solid var(--rule);border-radius:var(--r)">${c.defaultCategory==='all'?'<span style="color:var(--ink3)">Any</span>':window.escHtml(chCatLabel(c.defaultCategory))}</div></div>
      <div class="form-row"><label class="form-label">Default agent</label><div style="font-size:13px;color:var(--ink);padding:9px 12px;background:var(--off2);border:1px solid var(--rule);border-radius:var(--r)">${c.defaultAgent ? window.escHtml(c.defaultAgent) : '<span style="color:var(--ink3)">Round-robin</span>'}</div></div>
    </div>
    <div class="form-row"><label class="form-label">Default priority</label><div style="font-size:13px;padding:9px 12px;background:var(--off2);border:1px solid var(--rule);border-radius:var(--r)">${c.defaultPriority ? `<span class="tag tag-${window.escAttr(c.defaultPriority)}" style="text-transform:capitalize">${window.escHtml(c.defaultPriority)}</span>` : '<span style="color:var(--ink3)">None — tickets arrive as Normal</span>'}</div></div>
    ${c.signature ? `<div class="form-row"><label class="form-label">Signature</label><div style="font-size:12.5px;color:var(--ink2);padding:10px 12px;background:var(--off2);border:1px solid var(--rule);border-radius:var(--r);white-space:pre-wrap;line-height:1.5">${window.escHtml(c.signature)}</div></div>` : ''}
    <div style="margin-top:8px;font-size:11px;color:var(--ink3);font-family:'DM Mono',monospace">${c.volume30d || 0} tickets received in the last 30 days</div>
  `, null, null);
}

function chToggle(id, active) {
  if (!window.isAdmin()) return;
  const c = CHANNELS.find(x => x.id === id);
  if (!c) return;
  const prev = c.status;
  c.status = active ? 'active' : 'inactive';
  if (c._uuid) {
    apiPatch(`/api/v1/channels/${c._uuid}`, { status: c.status }).catch((err) => {
      c.status = prev;                     // revert the optimistic flip
      // Only re-render if the user is still looking at this page — the
      // failure can land after they've navigated elsewhere.
      if (CURRENT_PAGE === 'channels') renderPage('channels');
      alert(`Couldn't update: ${err?.message || err}`);
    });
  }
}

function chFormBody(c) {
  // Live workspaces hydrate CATEGORIES (key/label/is_active); the demo
  // persona's is empty, so fall back to the legacy TICKETS-derived labels
  // (demo category keys ARE the labels).
  const cats = CATEGORIES.length
    ? CATEGORIES.filter(x => x.is_active).map(x => ({ key: x.key, label: x.label }))
    : [...new Set(TICKETS.map(t => t.category))].map(l => ({ key: l, label: l }));
  return `
    <div class="form-grid">
      <div class="form-row"><label class="form-label">Name</label><input class="form-input" id="ch-name" value="${window.escHtml(c?.name ?? '')}" placeholder="e.g. EU Support inbox"/></div>
      <div class="form-row"><label class="form-label">Type</label>
        <select class="form-input" id="ch-type">${CH_TYPES.map(t => `<option value="${window.escHtml(t.v)}" ${(c?.type||'email')===t.v?'selected':''}>${window.escHtml(t.l)}</option>`).join('')}</select>
      </div>
    </div>
    <div class="form-row"><label class="form-label">Address</label><input class="form-input" id="ch-address" value="${window.escHtml(c?.address ?? '')}" placeholder="email@example.com / URL / endpoint"/></div>
    <div class="form-grid">
      <div class="form-row"><label class="form-label">Default category</label>
        <select class="form-input" id="ch-cat"><option value="all" ${(c?.defaultCategory||'all')==='all'?'selected':''}>Any</option>${cats.map(cat => `<option value="${window.escAttr(cat.key)}" ${c?.defaultCategory===cat.key?'selected':''}>${window.escHtml(cat.label)}</option>`).join('')}</select>
      </div>
      <div class="form-row"><label class="form-label">Default agent</label>
        <select class="form-input" id="ch-agent">
          <option value="">Round-robin (no fixed agent)</option>
          ${AGENTS.map(a => `<option value="${window.escAttr(a.userId || a.name)}" ${c?.defaultAgent===a.name?'selected':''}>${window.escHtml(a.name)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-row"><label class="form-label">Default priority</label>
      <select class="form-input" id="ch-pri">
        <option value="">No default — tickets arrive as Normal</option>
        ${CH_PRIORITIES.map(p => `<option value="${p}" ${c?.defaultPriority===p?'selected':''} style="text-transform:capitalize">${p[0].toUpperCase()+p.slice(1)}</option>`).join('')}
      </select>
      <div style="font-size:11px;color:var(--ink3);margin-top:4px;line-height:1.4">Email sent to this channel's address creates its ticket at this priority — e.g. complaint@ as Urgent.</div>
    </div>
    <div class="form-row"><label class="form-label">Signature (optional)</label><textarea class="form-input" id="ch-sig" style="min-height:80px;font-family:'Inter',sans-serif">${window.escHtml(c?.signature||'')}</textarea></div>
    <div style="display:flex;align-items:center;gap:10px;padding:6px 0">
      <span style="font-family:'Inter',sans-serif;font-size:11px;font-weight:500;letter-spacing:.04em;text-transform:uppercase;color:var(--ink3)">Active</span>
      <label class="toggle"><input type="checkbox" id="ch-active" ${(!c || c.status==='active')?'checked':''}><span class="toggle-slider"></span></label>
    </div>`;
}

// Read the modal form into an API payload. Demo persona consumes the same
// values via chFormLocal below.
function chFormPayload() {
  const agentSel = document.getElementById('ch-agent');
  return {
    name:                     document.getElementById('ch-name').value.trim(),
    type:                     document.getElementById('ch-type').value,
    address:                  document.getElementById('ch-address').value.trim() || null,
    status:                   document.getElementById('ch-active').checked ? 'active' : 'inactive',
    default_category_key:     document.getElementById('ch-cat').value === 'all' ? null : document.getElementById('ch-cat').value,
    default_priority_key:     document.getElementById('ch-pri').value || null,
    default_assigned_user_id: chApiBacked() ? (agentSel.value || null) : null,
    signature:                document.getElementById('ch-sig').value || null,
  };
}

function chNextId() {
  const max = Math.max(0, ...CHANNELS.map(x => parseInt((x.id||'').split('-')[1] || '0', 10)));
  return 'CH-' + String(max + 1).padStart(3, '0');
}

// Demo-persona shape from the same form (no API round-trip). The agent
// select's option values are userIds on live and names on demo (data.js
// agents have no userId), so resolve back to the display name either way.
function chFormLocal(payload) {
  const agentVal = document.getElementById('ch-agent').value;
  const agent = AGENTS.find(a => (a.userId || a.name) === agentVal);
  return {
    name: payload.name, type: payload.type, address: payload.address || '',
    defaultCategory: payload.default_category_key || 'all',
    defaultPriority: payload.default_priority_key || '',
    defaultAgent:    agent?.name || '',
    signature:       payload.signature || '',
    status:          payload.status,
  };
}

function chNew() {
  if (!window.isAdmin()) return;
  showModal('New channel', chFormBody(null), async () => {
    const payload = chFormPayload();
    if (!payload.name || !payload.address) return;
    if (chBusy) return;
    chBusy = true;
    try {
      if (chApiBacked()) {
        let resp;
        try { resp = await apiPost('/api/v1/channels', payload); }
        catch (err) { alert(`Couldn't create: ${err?.message || err}`); return; }
        CHANNELS.unshift(chMapResponse(resp.channel));
      } else {
        CHANNELS.unshift({ id: chNextId(), ...chFormLocal(payload), volume30d: 0 });
      }
      closeModal(); renderPage('channels');
    } finally { chBusy = false; }
  }, 'Create');
}

function chEdit(id) {
  if (!window.isAdmin()) return;
  const c = CHANNELS.find(x => x.id === id); if (!c) return;
  showModal(`Edit ${c.id}`, chFormBody(c), async () => {
    const payload = chFormPayload();
    if (!payload.name || !payload.address) return;
    if (chBusy) return;
    chBusy = true;
    try {
      if (c._uuid) {
        let resp;
        try { resp = await apiPatch(`/api/v1/channels/${c._uuid}`, payload); }
        catch (err) { alert(`Couldn't save: ${err?.message || err}`); return; }
        Object.assign(c, chMapResponse(resp.channel));
      } else {
        Object.assign(c, chFormLocal(payload));
      }
      closeModal(); renderPage('channels');
    } finally { chBusy = false; }
  }, 'Save');
}

function chDelete(id) {
  if (!window.isAdmin()) return;
  const c = CHANNELS.find(x => x.id === id); if (!c) return;
  showModal('Delete channel', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Delete <strong style="color:var(--ink)">${window.escHtml(c.name)}</strong>? Incoming email to its address will stop matching it and arrive with no channel defaults. Past tickets and their email history are kept.</div>`, async () => {
    if (chBusy) return;
    chBusy = true;
    try {
      if (c._uuid) {
        try { await apiDelete(`/api/v1/channels/${c._uuid}`); }
        catch (err) { alert(`Couldn't delete: ${err?.message || err}`); return; }
      }
      const i = CHANNELS.findIndex(x => x.id === id);
      if (i >= 0) CHANNELS.splice(i, 1);
      closeModal(); renderPage('channels');
    } finally { chBusy = false; }
  }, 'Delete');
}

registerActions({
  'ch.open':   (ds) => openChannel(ds.chId),
  'ch.new':    () => chNew(),
  'ch.edit':   (ds) => chEdit(ds.chId),
  'ch.delete': (ds) => chDelete(ds.chId),
});

registerChangeActions({
  'ch.toggle':    (ds, el) => chToggle(ds.chId, el.checked),
  'ch.setFilter': (ds, el) => { setChFilter(el.value); renderPage('channels'); },
});
