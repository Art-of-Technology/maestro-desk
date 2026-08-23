// ─── Layouts ─────────────────────────────────────────────────────────────────
// Drives which fields appear (and which are required) on the new-ticket and
// new-customer forms, and on the customer-detail Profile card. Locked fields
// are key info that the schema can't function without — we still render them
// in the UI but disable the Required toggle so admins can't accidentally
// turn off something the rest of the app depends on.
//
// isFieldVisible and isFieldRequired are the read API; tickets/new-ticket.js
// (showNewTicketModal) and customers/index.js (renderCustomerDetail) import
// them to gate fields and validate on submit.
//
// Persistence (Phase 4, PR 3): FIELD_LAYOUTS below is the CODE DEFAULT.
// On a real-auth session, bootstrap fetches GET /api/v1/workspace/layouts and
// calls hydrateLayouts() to overlay the workspace's persisted rows; every
// admin toggle then writes the scope's full desired set back with a PUT.
// The demo persona never persists — its toggles stay in-memory, as before.
//
// Click/change handlers route through core/event-delegation.js. No
// inline `on*=` references remain.
//
// External reaches (interim, via window): isAdmin, escAttr, escHtml —
// all still in app.js.

import { CURRENT_PAGE, LAYOUTS_TAB, setLayoutsTab } from '../core/state.js';
import { renderPage } from '../core/router.js';
import { registerActions, registerChangeActions } from '../core/event-delegation.js';
import { apiGet, apiPut, getJwt, getWorkspaceId } from '../core/api-client.js';
import { showToast } from '../core/toast.js';

// Entity ↔ server scope mapping — mirrors the route comment block in
// api/src/routes/workspace.ts (the single source of truth). The third scope,
// 'customer_areas', arrives with the area-reorder PR.
const SCOPE_FOR_ENTITY = { ticket: 'ticket_form', customer: 'customer_fields' };

const FIELD_LAYOUTS = {
  ticket: [
    { key:'subject',    label:'Subject',          locked:true,  required:true,  visible:true },
    { key:'customerId', label:'Customer',         locked:true,  required:true,  visible:true },
    { key:'category',   label:'Category',         locked:true,  required:true,  visible:true },
    { key:'priority',   label:'Priority',         locked:false, required:false, visible:true },
    { key:'agent',      label:'Assignee',         locked:false, required:false, visible:true },
    { key:'message',    label:'First message',    locked:false, required:false, visible:true },
    { key:'tags',       label:'Tags',             locked:false, required:false, visible:true },
  ],
  customer: [
    { key:'first',        label:'First name',     locked:true,  required:true,  visible:true },
    { key:'last',         label:'Last name',      locked:true,  required:true,  visible:true },
    { key:'email',        label:'Email',          locked:false, required:true,  visible:true },
    { key:'mobile',       label:'Mobile',         locked:false, required:false, visible:true },
    { key:'username',     label:'Username',       locked:false, required:false, visible:true },
    { key:'brand',        label:'Brand',          locked:false, required:false, visible:true },
    { key:'vip',          label:'VIP tier',       locked:false, required:false, visible:true },
    { key:'jurisdiction', label:'Jurisdiction',   locked:false, required:false, visible:true },
    { key:'since',        label:'Customer since', locked:false, required:false, visible:true },
  ],
};

// Immutable snapshot of the code defaults, taken before any hydration or
// toggle can mutate FIELD_LAYOUTS. hydrateLayouts resets from this first so
// switching to a workspace with NO persisted rows can't inherit the previous
// workspace's layout.
const FIELD_DEFAULTS = Object.fromEntries(
  Object.entries(FIELD_LAYOUTS).map(([entity, fields]) => [entity, fields.map(f => ({ ...f }))]),
);

// True only while the server's persisted layout state is KNOWN — set by a
// successful GET (including the old-API 404 fallback, where "no rows" is the
// truth). While false, admin toggles stay local-only: a PUT fired without
// knowing the server state would replace the workspace's real saved layout
// with whatever this browser happens to be showing (code defaults, usually).
let LAYOUTS_PERSISTABLE = false;

// Overlay persisted rows (from GET /api/v1/workspace/layouts) onto the code
// defaults; pass null to mean "server state unknown / signed out", which
// resets to code defaults AND blocks persistence until the next real hydrate.
// Resolution rule, per scope: if any rows exist, order by sort_order and
// append code keys with no row after max(sort_order) in code order; otherwise
// pure code order + code defaults. Locked fields keep their code flags
// regardless of what the DB says — the schema depends on them. Each entity
// array is reset from the immutable FIELD_DEFAULTS snapshot first, so a
// workspace switch can't inherit the previous workspace's layout.
export function hydrateLayouts(rows) {
  LAYOUTS_PERSISTABLE = Array.isArray(rows);
  for (const [entity, scope] of Object.entries(SCOPE_FOR_ENTITY)) {
    const fields = FIELD_LAYOUTS[entity];
    const defaults = FIELD_DEFAULTS[entity];
    fields.length = 0;
    for (const d of defaults) fields.push({ ...d });

    const scopeRows = (rows || []).filter(r => r.scope === scope);
    if (!scopeRows.length) continue;   // untouched scope → code defaults stand

    const byKey = Object.fromEntries(scopeRows.map(r => [r.element_key, r]));
    for (const f of fields) {
      const row = byKey[f.key];
      if (!row || f.locked) continue;
      f.visible = row.visible !== false;
      f.required = Boolean(row.required) && f.visible;
    }
    const maxSort = Math.max(...scopeRows.map(r => r.sort_order || 0));
    const pos = new Map(fields.map((f, i) => [f.key, byKey[f.key] ? byKey[f.key].sort_order : maxSort + 1 + i]));
    fields.sort((a, b) => pos.get(a.key) - pos.get(b.key));
  }
}

// Write one entity's FULL desired set to the server (dense-set replace —
// same contract as the Maestro manifest families). Demo persona (no JWT/
// workspace) skips the write entirely — session decides, never a field value
// (Phase-3 lesson).
//
// PUTs are SERIALIZED per scope through a promise chain, and the element set
// is snapshotted at SEND time, not queue time — so rapid toggles can't
// reorder in flight (last write genuinely carries the latest state, and a
// duplicate set from a coalesced earlier toggle is harmless). On failure the
// UI re-syncs from server truth with a fresh GET rather than reverting a
// captured field object — a re-hydrate (workspace switch) may have orphaned
// that object, and a revert would silently disagree with the server anyway.
const PENDING_PUTS = {};   // scope → tail of that scope's write chain
function persistLayoutScope(entity) {
  if (!(getJwt() && getWorkspaceId())) return;
  if (!LAYOUTS_PERSISTABLE) {
    showToast("Layouts couldn't be loaded from the server, so this change is local-only until you reload.", 'warn');
    return;
  }
  const scope = SCOPE_FOR_ENTITY[entity];
  const wsAtQueue = getWorkspaceId();
  // The .catch(() => {}) is the chain's wedge-guard: the async body below
  // handles its own failures, but if a link ever rejected anyway, every
  // later toggle for this scope would silently stop persisting.
  PENDING_PUTS[scope] = (PENDING_PUTS[scope] || Promise.resolve()).catch(() => {}).then(async () => {
    // Workspace switched while this write was queued — the snapshot below
    // would read the NEW workspace's arrays and the header would target it.
    if (getWorkspaceId() !== wsAtQueue) return;
    const elements = FIELD_LAYOUTS[entity].map(f => ({
      element_key: f.key,
      visible:     !!f.visible,
      required:    !!f.required,
    }));
    try {
      await apiPut(`/api/v1/workspace/layouts/${scope}`, { elements });
    } catch (err) {
      showToast(`Couldn't save the layout: ${err?.message || err}`, 'error');
      try {
        const res = await apiGet('/api/v1/workspace/layouts');
        if (getWorkspaceId() !== wsAtQueue) return;
        hydrateLayouts(res.layouts || []);
        if (CURRENT_PAGE === 'layouts') renderPage('layouts');
      } catch {
        // Server unreachable — keep the optimistic local state; the next
        // successful bootstrap re-hydrates from truth.
      }
    }
  });
}

function getLayoutField(entity, key) {
  return (FIELD_LAYOUTS[entity] || []).find(f => f.key === key);
}

export function isFieldVisible(entity, key) {
  const f = getLayoutField(entity, key);
  return !f || f.visible !== false;
}

export function isFieldRequired(entity, key) {
  const f = getLayoutField(entity, key);
  return f ? !!f.required : false;
}

function setLayoutFieldFlag(entity, key, flag, val) {
  const f = getLayoutField(entity, key);
  if (!f || f.locked) return;
  // Locked fields must stay required + visible; non-locked fields can flip
  // both flags freely. Marking a field invisible also implies non-required —
  // a hidden field can't be required without a way for the agent to fill it.
  // (The PUT's zod schema holds the same invariant server-side.)
  f[flag] = !!val;
  if (flag === 'visible' && !f.visible) f.required = false;
  if (flag === 'required' && f.required) f.visible = true;
  renderPage('layouts');
  persistLayoutScope(entity);
}

export function renderLayouts() {
  const admin = window.isAdmin();
  const tab = LAYOUTS_TAB;
  const fields = FIELD_LAYOUTS[tab] || [];
  const visN = fields.filter(f => f.visible).length;
  const reqN = fields.filter(f => f.required).length;
  const lockedN = fields.filter(f => f.locked).length;

  const rows = fields.map(f => `
    <tr>
      <td>
        <strong style="color:var(--ink)">${window.escHtml(f.label)}</strong>
        ${f.locked ? '<span style="margin-left:8px;font-family:\'DM Mono\',monospace;font-size:10px;color:var(--ink3);background:var(--off2);padding:1px 6px;border-radius:3px">key</span>' : ''}
        <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);margin-top:2px">${window.escHtml(f.key)}</div>
      </td>
      <td style="text-align:center">
        <label class="toggle">
          <input type="checkbox" ${f.required?'checked':''} ${(!admin || f.locked)?'disabled':''} data-change-action="layouts.setFieldFlag" data-tab="${window.escAttr(tab)}" data-key="${window.escAttr(f.key)}" data-flag="required">
          <span class="toggle-slider"></span>
        </label>
        ${f.locked ? '<div style="font-size:10px;color:var(--ink3);margin-top:2px;font-style:italic">locked</div>' : ''}
      </td>
      <td style="text-align:center">
        <label class="toggle">
          <input type="checkbox" ${f.visible?'checked':''} ${(!admin || f.locked)?'disabled':''} data-change-action="layouts.setFieldFlag" data-tab="${window.escAttr(tab)}" data-key="${window.escAttr(f.key)}" data-flag="visible">
          <span class="toggle-slider"></span>
        </label>
        ${f.locked ? '<div style="font-size:10px;color:var(--ink3);margin-top:2px;font-style:italic">locked</div>' : ''}
      </td>
    </tr>`).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Layouts</div>
        <span style="font-size:11px;color:var(--ink3);font-style:italic">${admin ? 'Toggle each field as required or visible. Key fields stay locked so the rest of the app keeps working.' : 'Read-only — admin access required to edit'}</span>
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${fields.length}</div><div class="kpi-l">Fields</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${visN}</div><div class="kpi-l">Visible</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${reqN}</div><div class="kpi-l">Required</div></div>
        <div class="kpi"><div class="kpi-n">${lockedN}</div><div class="kpi-l">Locked</div></div>
      </div>
      <div class="filter-bar">
        <span class="filter-label">Apply to</span>
        <span class="filter-tag${tab==='ticket'?' active':''}" style="cursor:pointer" data-action="layouts.setTab" data-tab="ticket">Tickets</span>
        <span class="filter-tag${tab==='customer'?' active':''}" style="cursor:pointer" data-action="layouts.setTab" data-tab="customer">Customers</span>
      </div>
      <div class="page-scroll">
        <table class="tbl">
          <thead><tr><th>Field</th><th style="text-align:center;width:120px">Required</th><th style="text-align:center;width:120px">Visible</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div style="margin-top:14px;font-size:11px;color:var(--ink3);line-height:1.5;padding:0 4px">Hidden fields are dropped from the new-${tab} form${tab === 'ticket' ? '' : ' and the customer profile card'}. Required fields validate on submit. Marking a field hidden also clears its required flag — a hidden field with no input path would be unfillable.</div>
      </div>
    </div>`;
}

registerActions({
  'layouts.setTab': (ds) => { setLayoutsTab(ds.tab); renderPage('layouts'); },
});

registerChangeActions({
  'layouts.setFieldFlag': (ds, el) => setLayoutFieldFlag(ds.tab, ds.key, ds.flag, el.checked),
});
