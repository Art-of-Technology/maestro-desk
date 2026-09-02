// ─── Layouts ─────────────────────────────────────────────────────────────────
// Drives which fields appear (and which are required) on the new-ticket and
// new-customer forms and on the customer-detail Profile card — and, via the
// Profile-areas tab, the order + visibility of the customer profile's page
// areas (drag-to-reorder; persisted under the customer_areas scope). Locked
// fields are key info that the schema can't function without — we still
// render them in the UI but disable the Required toggle so admins can't
// accidentally turn off something the rest of the app depends on.
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
    // headerOwned: rendered by the profile's name header, never by the
    // details card's field loop — without the marker a data-driven map
    // would emit duplicate First/Last rows under the header that already
    // shows the name.
    { key:'first',        label:'First name',     locked:true,  required:true,  visible:true, headerOwned:true },
    { key:'last',         label:'Last name',      locked:true,  required:true,  visible:true, headerOwned:true },
    { key:'email',        label:'Email',          locked:false, required:true,  visible:true },
    { key:'mobile',       label:'Mobile',         locked:false, required:false, visible:true },
    { key:'username',     label:'Username',       locked:false, required:false, visible:true },
    { key:'brand',        label:'Brand',          locked:false, required:false, visible:true },
    { key:'vip',          label:'VIP tier',       locked:false, required:false, visible:true },
    { key:'jurisdiction', label:'Jurisdiction',   locked:false, required:false, visible:true },
    { key:'since',        label:'Customer since', locked:false, required:false, visible:true },
    // Rendered outside the details card until the contacts/card PRs move
    // them in (consent = the KPI tile, backoffice_url = the quick-action
    // button) — but they're real profile fields, so they're admin-toggleable
    // now and hold their place in the field order. `note` names the render
    // home in the admin table so the toggle's reach is explicit (hiding the
    // Stats tiles AREA also hides the consent tile, whatever this says);
    // `requiredNA` drops the Required toggle — neither is a form input yet,
    // so a required flag would persist without anything consuming it.
    { key:'consent',        label:'Marketing consent', locked:false, required:false, visible:true, requiredNA:true, note:'shown in the Stats tiles area' },
    { key:'backoffice_url', label:'Backoffice link',   locked:false, required:false, visible:true, requiredNA:true, note:'shown in Quick actions' },
  ],
};

// The customer profile's AREAS — the reorderable page blocks, distinct from
// the per-field lists above. Keyed by NAME (matching the area registry in
// customers/index.js renderCustomerDetail), never by position. `width`
// drives the pairing rule: neighbouring half-width areas share one grid row;
// a full-width area between them splits the pair. `pinned` = fixed at
// position one and always visible (the details area is the record's
// identity; the profile-card PR builds on it staying put).
const AREA_LAYOUTS = [
  { key:'details',      label:'Profile details',   width:'half', pinned:true,  visible:true },
  { key:'customFields', label:'Custom fields',     width:'half', pinned:false, visible:true },
  { key:'risk',         label:'Risk factors',      width:'full', pinned:false, visible:true },
  { key:'kpis',         label:'Stats tiles',       width:'full', pinned:false, visible:true },
  { key:'tags',         label:'Common topics',     width:'full', pinned:false, visible:true },
  { key:'timeline',     label:'Activity timeline', width:'half', pinned:false, visible:true },
  { key:'notes',        label:'Internal notes',    width:'half', pinned:false, visible:true },
  { key:'tickets',      label:'Tickets',           width:'full', pinned:false, visible:true },
];
const AREAS_SCOPE = 'customer_areas';   // server scope, per workspace.ts's mapping block

// Immutable snapshot of the code defaults, taken before any hydration or
// toggle can mutate FIELD_LAYOUTS. hydrateLayouts resets from this first so
// switching to a workspace with NO persisted rows can't inherit the previous
// workspace's layout.
const FIELD_DEFAULTS = Object.fromEntries(
  Object.entries(FIELD_LAYOUTS).map(([entity, fields]) => [entity, fields.map(f => ({ ...f }))]),
);
const AREA_DEFAULTS = AREA_LAYOUTS.map(a => ({ ...a }));

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

  // Same treatment for the profile AREAS (scope customer_areas): reset from
  // defaults, then overlay visibility + order. No pinned special cases here —
  // normalizeAreas() is the single authority that re-asserts the pinned
  // invariant (front position, always visible) after every mutation,
  // whatever the DB rows said.
  AREA_LAYOUTS.length = 0;
  for (const d of AREA_DEFAULTS) AREA_LAYOUTS.push({ ...d });
  const areaRows = (rows || []).filter(r => r.scope === AREAS_SCOPE);
  if (areaRows.length) {
    const byKey = Object.fromEntries(areaRows.map(r => [r.element_key, r]));
    for (const a of AREA_LAYOUTS) {
      if (!byKey[a.key]) continue;
      a.visible = byKey[a.key].visible !== false;
    }
    const maxSort = Math.max(...areaRows.map(r => r.sort_order || 0));
    const pos = new Map(AREA_LAYOUTS.map((a, i) => [a.key, byKey[a.key] ? byKey[a.key].sort_order : maxSort + 1 + i]));
    AREA_LAYOUTS.sort((a, b) => pos.get(a.key) - pos.get(b.key));
  }
  normalizeAreas();
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
function persistScope(scope, buildElements) {
  if (!(getJwt() && getWorkspaceId())) return;
  if (!LAYOUTS_PERSISTABLE) {
    showToast("Layouts couldn't be loaded from the server, so this change is local-only until you reload.", 'warn');
    return;
  }
  const wsAtQueue = getWorkspaceId();
  // The .catch(() => {}) is the chain's wedge-guard: the async body below
  // handles its own failures, but if a link ever rejected anyway, every
  // later toggle for this scope would silently stop persisting.
  PENDING_PUTS[scope] = (PENDING_PUTS[scope] || Promise.resolve()).catch(() => {}).then(async () => {
    // Workspace switched while this write was queued — the snapshot below
    // would read the NEW workspace's arrays and the header would target it.
    if (getWorkspaceId() !== wsAtQueue) return;
    const elements = buildElements();
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

function persistLayoutScope(entity) {
  persistScope(SCOPE_FOR_ENTITY[entity], () => FIELD_LAYOUTS[entity].map(f => ({
    element_key: f.key,
    visible:     !!f.visible,
    required:    !!f.required,
  })));
}

// Areas carry no 'required' concept — the server refuses it for this scope.
// `empty: true` PUTs the empty set, which clears the scope server-side (the
// documented "back to code defaults" semantics from the persistence PR).
function persistAreas({ empty = false } = {}) {
  persistScope(AREAS_SCOPE, () => empty ? [] : AREA_LAYOUTS.map(a => ({
    element_key: a.key,
    visible:     !!a.visible,
    required:    false,
  })));
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

// Read-only view of an entity's field list, in admin-configured order —
// customers/index.js renders the details card's rows from it. Callers must
// not mutate; all writes go through setLayoutFieldFlag.
export function getLayoutFields(entity) {
  return FIELD_LAYOUTS[entity] || [];
}

// The profile's visible areas, grouped into render rows by the pairing rule:
// neighbouring half-width areas share one row; a full-width area (or the end
// of the list) closes any half-row as a single. customers/index.js feeds
// this straight into its area-row renderer.
export function getProfileAreaRows() {
  const rows = [];
  let pendingHalf = null;
  for (const a of AREA_LAYOUTS) {
    if (!a.visible) continue;
    if (a.width === 'half') {
      if (pendingHalf) { rows.push([pendingHalf, a.key]); pendingHalf = null; }
      else pendingHalf = a.key;
    } else {
      if (pendingHalf) { rows.push([pendingHalf]); pendingHalf = null; }
      rows.push([a.key]);
    }
  }
  if (pendingHalf) rows.push([pendingHalf]);
  return rows;
}

// Whether an area is half-width — the profile renderer needs it for a half
// area widowed into its own row (partner hidden or pair split): the card
// blocks carry no bottom margin of their own, so a widowed half still needs
// the grid wrapper for row spacing, while full-width blocks bring their own
// margins and render bare, as they always have.
export function areaIsHalf(key) {
  return AREA_LAYOUTS.find(a => a.key === key)?.width === 'half';
}

// The pinned invariant (front position, always visible), applied as a
// single post-mutation pass so every write path — hydrate, drop, reset, and
// whatever the profile-card PR adds — ends in a valid state without each
// carrying its own guards. The UI-level checks (disabled toggle, no
// draggable) remain, but only as mirrors of `pinned`; this is the authority.
// sort() is spec-stable, so non-pinned areas keep their relative order.
function normalizeAreas() {
  for (const a of AREA_LAYOUTS) if (a.pinned) a.visible = true;
  AREA_LAYOUTS.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
}

function setAreaVisible(key, val) {
  const a = AREA_LAYOUTS.find(x => x.key === key);
  if (!a || a.pinned) return;
  a.visible = !!val;
  normalizeAreas();
  renderPage('layouts');
  persistAreas();
}

function dropAreaRow(targetKey) {
  const src = AREA_LAYOUTS.find(x => x.key === AREA_DRAG_KEY);
  const tgt = AREA_LAYOUTS.find(x => x.key === targetKey);
  AREA_DRAG_KEY = null;
  if (!src || !tgt || src === tgt || src.pinned || tgt.pinned) return;
  // Same insert semantics as customers/index.js dropCustCol: target index
  // taken before the removal.
  const si = AREA_LAYOUTS.indexOf(src), ti = AREA_LAYOUTS.indexOf(tgt);
  AREA_LAYOUTS.splice(si, 1);
  AREA_LAYOUTS.splice(ti, 0, src);
  normalizeAreas();
  renderPage('layouts');
  persistAreas();
}

function resetAreas() {
  AREA_LAYOUTS.length = 0;
  for (const d of AREA_DEFAULTS) AREA_LAYOUTS.push({ ...d });
  normalizeAreas();
  renderPage('layouts');
  persistAreas({ empty: true });
}

function setLayoutFieldFlag(entity, key, flag, val) {
  const f = getLayoutField(entity, key);
  if (!f || f.locked) return;
  if (flag === 'required' && f.requiredNA) return;   // no Required toggle exists for these
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
  if (tab === 'areas') return renderAreasTab(admin);
  const fields = FIELD_LAYOUTS[tab] || [];
  const visN = fields.filter(f => f.visible).length;
  const reqN = fields.filter(f => f.required).length;
  const lockedN = fields.filter(f => f.locked).length;

  const rows = fields.map(f => `
    <tr>
      <td>
        <strong style="color:var(--ink)">${window.escHtml(f.label)}</strong>
        ${f.locked ? '<span style="margin-left:8px;font-family:\'DM Mono\',monospace;font-size:10px;color:var(--ink3);background:var(--off2);padding:1px 6px;border-radius:3px">key</span>' : ''}
        <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);margin-top:2px">${window.escHtml(f.key)}${f.note ? ` · <span style="font-style:italic">${window.escHtml(f.note)}</span>` : ''}</div>
      </td>
      <td style="text-align:center">
        ${f.requiredNA ? '<span style="color:var(--ink4)" title="Not a form input — required does not apply">—</span>' : `<label class="toggle">
          <input type="checkbox" ${f.required?'checked':''} ${(!admin || f.locked)?'disabled':''} data-change-action="layouts.setFieldFlag" data-tab="${window.escAttr(tab)}" data-key="${window.escAttr(f.key)}" data-flag="required">
          <span class="toggle-slider"></span>
        </label>`}
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
      ${layoutsTabBar(tab)}
      <div class="page-scroll">
        <table class="tbl">
          <thead><tr><th>Field</th><th style="text-align:center;width:120px">Required</th><th style="text-align:center;width:120px">Visible</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div style="margin-top:14px;font-size:11px;color:var(--ink3);line-height:1.5;padding:0 4px">Hidden fields are dropped from the new-${tab} form${tab === 'ticket' ? '' : ' and the customer profile card'}. Required fields validate on submit. Marking a field hidden also clears its required flag — a hidden field with no input path would be unfillable.</div>
      </div>
    </div>`;
}

function layoutsTabBar(tab) {
  return `
      <div class="filter-bar">
        <span class="filter-label">Apply to</span>
        <span class="filter-tag${tab==='ticket'?' active':''}" style="cursor:pointer" data-action="layouts.setTab" data-tab="ticket">Tickets</span>
        <span class="filter-tag${tab==='customer'?' active':''}" style="cursor:pointer" data-action="layouts.setTab" data-tab="customer">Customers</span>
        <span class="filter-tag${tab==='areas'?' active':''}" style="cursor:pointer" data-action="layouts.setTab" data-tab="areas">Profile areas</span>
      </div>`;
}

// The Profile-areas tab: the customer profile's areas as a drag-to-reorder
// list with visibility toggles. Order + visibility persist per workspace via
// the customer_areas layout scope; Reset clears the scope so code defaults
// apply again. The pinned details area is neither draggable nor hideable.
function renderAreasTab(admin) {
  const visN = AREA_LAYOUTS.filter(a => a.visible).length;
  const rows = AREA_LAYOUTS.map(a => `
    <div class="card layout-area-row"${admin && !a.pinned ? ' draggable="true"' : ''} data-area-key="${window.escAttr(a.key)}" style="display:flex;align-items:center;gap:12px;padding:10px 14px;margin-bottom:8px;max-width:620px${admin && !a.pinned ? ';cursor:grab' : ''}" title="${admin && !a.pinned ? 'Drag to reorder' : ''}">
      <span style="opacity:.35;font-size:13px;user-select:none">${a.pinned ? '&#128204;' : '&#10303;'}</span>
      <span>
        <strong style="color:var(--ink);font-size:13px">${window.escHtml(a.label)}</strong>
        <span style="margin-left:8px;font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${window.escHtml(a.key)}</span>
      </span>
      ${a.pinned ? '<span style="font-family:\'DM Mono\',monospace;font-size:10px;color:var(--ink3);background:var(--off2);padding:1px 6px;border-radius:3px">pinned</span>' : ''}
      <span class="tag tag-neutral" style="margin-left:auto;font-size:10px">${a.width === 'half' ? 'half width' : 'full width'}</span>
      <label class="toggle">
        <input type="checkbox" ${a.visible?'checked':''} ${(!admin || a.pinned)?'disabled':''} data-change-action="layouts.setAreaVisible" data-key="${window.escAttr(a.key)}">
        <span class="toggle-slider"></span>
      </label>
    </div>`).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Layouts</div>
        <span style="font-size:11px;color:var(--ink3);font-style:italic">${admin ? "Drag to reorder the customer profile's areas. Hidden areas disappear for every agent." : 'Read-only — admin access required to edit'}</span>
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${AREA_LAYOUTS.length}</div><div class="kpi-l">Areas</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${visN}</div><div class="kpi-l">Visible</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${AREA_LAYOUTS.length - visN}</div><div class="kpi-l">Hidden</div></div>
        <div class="kpi"><div class="kpi-n">${AREA_LAYOUTS.filter(a => a.pinned).length}</div><div class="kpi-l">Pinned</div></div>
      </div>
      ${layoutsTabBar('areas')}
      <div class="page-scroll">
        ${rows}
        ${admin ? `<button class="btn btn-sm" style="margin-top:6px" data-action="layouts.resetAreas">&#8634; Reset to default</button>` : ''}
        <div style="margin-top:14px;font-size:11px;color:var(--ink3);line-height:1.5;padding:0 4px">Half-width areas share a row when they sit next to each other; a full-width area between them splits the pair. The avatar header, merged banner and quick-actions bar keep their place at the top (individual buttons can still follow their own field toggles, like Backoffice). Hiding an area is display-only — the data stays, and Reset to default brings everything back.</div>
      </div>
    </div>`;
}

registerActions({
  'layouts.setTab': (ds) => { setLayoutsTab(ds.tab); renderPage('layouts'); },
  'layouts.resetAreas': () => resetAreas(),
});

registerChangeActions({
  'layouts.setFieldFlag': (ds, el) => setLayoutFieldFlag(ds.tab, ds.key, ds.flag, el.checked),
  'layouts.setAreaVisible': (ds, el) => setAreaVisible(ds.key, el.checked),
});

// ─── Area drag-and-drop dispatcher ───────────────────────────────────────────
// Same document-level pattern as customers/index.js's column drag; the
// selector `.layout-area-row[draggable="true"]` disambiguates from that
// module's `th[draggable="true"]` and widget-shell's
// `.widget[draggable="true"]`, so all three coexist. (A shared
// registerDragActions in core/event-delegation.js is the noted follow-up —
// this is the third copy of the pattern.)
//
// Guards, in order of appearance:
// - dragstart requires e.target === row: when the row itself is dragged the
//   browser targets the draggable element, but a text-selection drag started
//   inside the row targets the inner node — without the check it would arm
//   a reorder.
// - State is the dragged area's KEY, not its index: a re-render or
//   re-hydrate between dragstart and drop (e.g. a failed PUT's recovery
//   path) re-sorts AREA_LAYOUTS, and a stale index would move the wrong
//   area. Names survive; positions don't — the module's own design rule.
// - dragover/drop respond only while a row drag is armed, so an OS file (or
//   any foreign drag) is never advertised as droppable here and can't
//   trigger the browser's default file-open navigation.
// - dragend always clears the key, so an aborted drag can't leave a stale
//   armed state for a later unrelated drop.
let AREA_DRAG_KEY = null;
function _dragAreaRow(e) { return e.target.closest?.('.layout-area-row[draggable="true"]'); }
document.addEventListener('dragstart', e => {
  const row = _dragAreaRow(e); if (!row || e.target !== row) return;
  AREA_DRAG_KEY = row.dataset.areaKey || null;
});
document.addEventListener('dragend', () => { AREA_DRAG_KEY = null; });
document.addEventListener('dragover', e => {
  if (AREA_DRAG_KEY !== null && _dragAreaRow(e)) e.preventDefault();
});
document.addEventListener('drop', e => {
  if (AREA_DRAG_KEY === null) return;
  const row = _dragAreaRow(e); if (!row) return;
  e.preventDefault();
  dropAreaRow(row.dataset.areaKey);
});
