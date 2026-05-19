// ─── Layouts ─────────────────────────────────────────────────────────────────
// Drives which fields appear (and which are required) on the new-ticket and
// new-customer forms, and on the customer-detail Profile card. Locked fields
// are key info that the schema can't function without — we still render them
// in the UI but disable the Required toggle so admins can't accidentally
// turn off something the rest of the app depends on.
//
// isFieldVisible and isFieldRequired are the read API; app.js's
// showNewTicketModal and renderCustomerDetail import them to gate fields
// and validate on submit.
//
// Click/change handlers route through core/event-delegation.js. No
// inline `on*=` references remain. No external module calls into this
// module's exports from inline handlers — customers/index.js and
// tickets/detail.js use `isFieldVisible` / `isFieldRequired` via
// direct ES imports.
//
// External reaches (interim, via window): isAdmin, escAttr, escHtml,
// renderPage — all still in app.js.
//
// LAYOUTS_TAB comes from core/state.js via the global lexical env.

import { registerActions, registerChangeActions } from '../core/event-delegation.js';

const FIELD_LAYOUTS = {
  ticket: [
    { key:'subject',    label:'Subject',          locked:true,  required:true,  visible:true },
    { key:'customerId', label:'Customer',         locked:true,  required:true,  visible:true },
    { key:'category',   label:'Category',         locked:false, required:false, visible:true },
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
    { key:'kyc',          label:'KYC status',     locked:false, required:false, visible:true },
    { key:'since',        label:'Customer since', locked:false, required:false, visible:true },
  ],
};

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
  f[flag] = !!val;
  if (flag === 'visible' && !f.visible) f.required = false;
  if (flag === 'required' && f.required) f.visible = true;
  window.renderPage('layouts');
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
        <span class="filter-tag" style="cursor:pointer;${tab==='ticket'?'border-color:var(--purple);color:var(--purple);background:var(--purple-lt)':''}" data-action="layouts.setTab" data-tab="ticket">Tickets</span>
        <span class="filter-tag" style="cursor:pointer;${tab==='customer'?'border-color:var(--purple);color:var(--purple);background:var(--purple-lt)':''}" data-action="layouts.setTab" data-tab="customer">Customers</span>
      </div>
      <div class="page-scroll">
        <table class="tbl">
          <thead><tr><th>Field</th><th style="text-align:center;width:120px">Required</th><th style="text-align:center;width:120px">Visible</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div style="margin-top:14px;font-size:11px;color:var(--ink3);line-height:1.5;padding:0 4px">Hidden fields are dropped from the new-${tab} form and the ${tab === 'ticket' ? 'ticket sidebar' : 'customer profile card'}. Required fields validate on submit. Marking a field hidden also clears its required flag — a hidden field with no input path would be unfillable.</div>
      </div>
    </div>`;
}

registerActions({
  'layouts.setTab': (ds) => { LAYOUTS_TAB = ds.tab; window.renderPage('layouts'); },
});

registerChangeActions({
  'layouts.setFieldFlag': (ds, el) => setLayoutFieldFlag(ds.tab, ds.key, ds.flag, el.checked),
});
