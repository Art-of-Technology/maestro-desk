// ─── Custom Fields manager ───────────────────────────────────────────────────
// Config-section page for defining custom fields on customer and ticket
// entities (label, type, default value, required flag, select options).
//
// The "Manage custom fields" mini-modal is also owned here — it's invoked
// from the customer table's column panel via showManageFieldsModal().
//
// External reaches (interim, via window): isAdmin, escAttr, escHtml,
// showModal, closeModal, renderPage — all still in app.js.
//
// CUSTOM_FIELDS comes from data.js via the global lexical env;
// CF_FILTER_ENTITY comes from core/state.js the same way.
//
// Inline on*= handlers were migrated to data-action delegation (see the
// registerActions block at the bottom). renderCustomFields stays exported
// for the router; showManageFieldsModal stays exported for customers/index.js
// (direct ES import). The cf* mutators are now module-internal.

import { apiPost, apiPatch, apiDelete } from '../core/api-client.js';
import { registerActions, registerChangeActions } from '../core/event-delegation.js';

function cfApiBacked() {
  return CUSTOM_FIELDS.some((f) => f._uuid);
}

function cfMapResponse(r) {
  return {
    _uuid:        r.id,
    id:           r.key,
    label:        r.label,
    type:         r.field_type,
    entity:       r.entity_type,
    required:     Boolean(r.required),
    defaultValue: r.default_value || '',
    options:      r.options || undefined,
    sortOrder:    r.sort_order || 0,
  };
}

const CF_TYPES = [
  { v:'text',    l:'Text' },
  { v:'number',  l:'Number' },
  { v:'date',    l:'Date' },
  { v:'select',  l:'Select (single)' },
  { v:'boolean', l:'Boolean (yes/no)' },
];

export function renderCustomFields() {
  const admin = window.isAdmin();
  let list = [...CUSTOM_FIELDS];
  if (CF_FILTER_ENTITY !== 'all') list = list.filter(f => (f.entity || 'customer') === CF_FILTER_ENTITY);
  const total = CUSTOM_FIELDS.length;
  const byType = {};
  CUSTOM_FIELDS.forEach(f => { byType[f.type] = (byType[f.type] || 0) + 1; });

  const rows = list.map(f => {
    const entity = f.entity || 'customer';
    const def = f.defaultValue ?? '';
    return `<tr>
      <td class="bold">${f.id}</td>
      <td style="font-weight:500;color:var(--ink)">${window.escHtml(f.label)}</td>
      <td><span class="tag tag-neutral" style="font-size:10px;text-transform:capitalize">${window.escHtml(f.type)}</span></td>
      <td><span class="tag tag-neutral" style="font-size:10px;text-transform:capitalize">${entity}</span></td>
      <td style="font-size:12px;color:var(--ink2);font-family:'DM Mono',monospace">${def !== '' ? window.escHtml(String(def)) : '—'}</td>
      <td style="text-align:center">${f.required ? '<span class="tag tag-gdpr" style="font-size:10px">required</span>' : '<span style="color:var(--ink4);font-size:11px">—</span>'}</td>
      ${admin ? `<td style="text-align:right;white-space:nowrap">
        <button class="btn btn-sm" data-action="cf.edit" data-id="${window.escAttr(f.id)}">Edit</button>
        <button class="btn btn-sm btn-danger" data-action="cf.delete" data-id="${window.escAttr(f.id)}">Delete</button>
      </td>` : ''}
    </tr>`;
  }).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Custom Fields</div>
        ${admin ? `<button class="btn btn-solid btn-sm" data-action="cf.new">+ New Field</button>` : `<span style="font-size:11px;color:var(--ink3);font-style:italic">Read-only</span>`}
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Fields</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${CUSTOM_FIELDS.filter(f => (f.entity||'customer') === 'customer').length}</div><div class="kpi-l">On customers</div></div>
        <div class="kpi"><div class="kpi-n c-purple">${CUSTOM_FIELDS.filter(f => (f.entity||'customer') === 'ticket').length}</div><div class="kpi-l">On tickets</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${CUSTOM_FIELDS.filter(f => f.required).length}</div><div class="kpi-l">Required</div></div>
      </div>
      <div class="filter-bar">
        <span class="filter-label">Entity</span>
        <select class="filter-select" data-change-action="cf.filterEntity">
          <option value="all"      ${CF_FILTER_ENTITY==='all'?'selected':''}>All entities</option>
          <option value="customer" ${CF_FILTER_ENTITY==='customer'?'selected':''}>Customer fields</option>
          <option value="ticket"   ${CF_FILTER_ENTITY==='ticket'?'selected':''}>Ticket fields</option>
        </select>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${total}</span>
      </div>
      <div class="page-scroll">
        <table class="tbl">
          <thead><tr><th>ID</th><th>Label</th><th>Type</th><th>Entity</th><th>Default</th><th style="text-align:center">Required</th>${admin?'<th style="text-align:right">Actions</th>':''}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${list.length===0 ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No custom fields defined</div><div class="empty-line"></div></div>` : ''}
        <div style="margin-top:14px;font-size:11px;color:var(--ink3);line-height:1.5">Customer fields render in the customer detail page (Custom fields card). Ticket fields are reserved for future ticket-detail integration. Select fields use a comma-separated <code style="font-family:'DM Mono',monospace;font-size:11px">options</code> list captured at edit time.</div>
      </div>
    </div>`;
}

function cfFormBody(f) {
  const esc = s => String(s||'').replace(/"/g,'&quot;');
  const optsCsv = f && Array.isArray(f.options) ? f.options.join(', ') : '';
  return `
    <div class="form-grid">
      <div class="form-row"><label class="form-label">Label</label><input class="form-input" id="cf-label" value="${esc(f?.label)}" placeholder="e.g. Renewal Date"/></div>
      <div class="form-row"><label class="form-label">Type</label>
        <select class="form-input" id="cf-type" data-change-action="cf.toggleOptions">
          ${CF_TYPES.map(t => `<option value="${t.v}" ${(f?.type||'text')===t.v?'selected':''}>${t.l}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label class="form-label">Entity</label>
        <select class="form-input" id="cf-entity">
          <option value="customer" ${(f?.entity||'customer')==='customer'?'selected':''}>Customer</option>
          <option value="ticket"   ${f?.entity==='ticket'?'selected':''}>Ticket</option>
        </select>
      </div>
      <div class="form-row"><label class="form-label">Default value</label><input class="form-input" id="cf-default" value="${esc(f?.defaultValue)}" placeholder="optional"/></div>
    </div>
    <div class="form-row" id="cf-options-row" style="display:${f?.type==='select'?'block':'none'}">
      <label class="form-label">Options (comma-separated)</label>
      <input class="form-input" id="cf-options" value="${esc(optsCsv)}" placeholder="e.g. Bronze, Silver, Gold, Platinum"/>
    </div>
    <div style="display:flex;align-items:center;gap:10px;padding:6px 0">
      <span style="font-family:'Inter',sans-serif;font-size:11px;font-weight:500;letter-spacing:.04em;text-transform:uppercase;color:var(--ink3)">Required</span>
      <label class="toggle"><input type="checkbox" id="cf-required" ${f?.required?'checked':''}><span class="toggle-slider"></span></label>
    </div>`;
}

function cfFormToggleOptions(type) {
  const row = document.getElementById('cf-options-row');
  if (row) row.style.display = type === 'select' ? 'block' : 'none';
}

function cfReadForm() {
  const label = document.getElementById('cf-label').value.trim();
  const type = document.getElementById('cf-type').value;
  const entity = document.getElementById('cf-entity').value;
  const defaultValue = document.getElementById('cf-default').value;
  const required = document.getElementById('cf-required').checked;
  const options = type === 'select'
    ? document.getElementById('cf-options').value.split(',').map(s => s.trim()).filter(Boolean)
    : undefined;
  return { label, type, entity, defaultValue, required, options };
}

function cfNextId() {
  const max = Math.max(0, ...CUSTOM_FIELDS.map(x => parseInt((x.id || '').replace(/^cf/i, ''), 10) || 0));
  return 'cf' + (max + 1);
}

function cfNew() {
  if (!window.isAdmin()) return;
  window.showModal('New custom field', cfFormBody(null), async () => {
    const data = cfReadForm();
    if (!data.label) return;
    if (cfApiBacked()) {
      let resp;
      try {
        resp = await apiPost('/api/v1/custom-fields', {
          label:         data.label,
          field_type:    data.type,
          entity_type:   data.entity,
          required:      data.required,
          default_value: data.defaultValue || null,
          options:       data.options || null,
        });
      } catch (err) { alert(`Couldn't create: ${err?.message || err}`); return; }
      CUSTOM_FIELDS.unshift(cfMapResponse(resp.custom_field));
    } else {
      const field = { id: cfNextId(), label: data.label, type: data.type, entity: data.entity, required: data.required, defaultValue: data.defaultValue };
      if (data.options) field.options = data.options;
      CUSTOM_FIELDS.unshift(field);
    }
    window.closeModal(); window.renderPage('custom-fields');
  }, 'Create');
}

function cfEdit(id) {
  if (!window.isAdmin()) return;
  const f = CUSTOM_FIELDS.find(x => x.id === id); if (!f) return;
  window.showModal(`Edit ${f.id}`, cfFormBody(f), async () => {
    const data = cfReadForm();
    if (!data.label) return;
    // entity_type isn't editable server-side (would orphan custom_field_values
    // referencing the old (entity, key) pair). Inform the user if they tried.
    if (f._uuid && data.entity !== f.entity) {
      alert(`Can't change the entity type on an existing field — would orphan stored values. Delete this field and create a new one if you need to switch entity.`);
      return;
    }
    if (f._uuid) {
      try {
        await apiPatch(`/api/v1/custom-fields/${f._uuid}`, {
          label:         data.label,
          field_type:    data.type,
          required:      data.required,
          default_value: data.defaultValue || null,
          options:       data.options || null,
        });
      } catch (err) { alert(`Couldn't save: ${err?.message || err}`); return; }
    }
    f.label = data.label; f.type = data.type; f.entity = data.entity;
    f.required = data.required; f.defaultValue = data.defaultValue;
    if (data.options) f.options = data.options; else delete f.options;
    window.closeModal(); window.renderPage('custom-fields');
  }, 'Save');
}

function cfDelete(id) {
  if (!window.isAdmin()) return;
  const f = CUSTOM_FIELDS.find(x => x.id === id); if (!f) return;
  window.showModal('Delete custom field', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${window.escHtml(f.label)}</strong>? Existing values stored on customer / ticket records will become orphaned (not deleted).</div>`, async () => {
    if (f._uuid) {
      try { await apiDelete(`/api/v1/custom-fields/${f._uuid}`); }
      catch (err) { alert(`Couldn't delete: ${err?.message || err}`); return; }
    }
    const i = CUSTOM_FIELDS.findIndex(x => x.id === id);
    if (i >= 0) CUSTOM_FIELDS.splice(i, 1);
    window.closeModal(); window.renderPage('custom-fields');
  }, 'Delete');
}

export function showManageFieldsModal() {
  window.showModal('Manage custom fields', `
    ${CUSTOM_FIELDS.map(f => `<div class="ts-row"><span class="ts-key">${f.label}</span><span class="ts-val">${f.type}</span></div>`).join('')}
    <div style="font-size:11px;color:var(--ink3);margin-top:14px">Custom fields appear as toggleable columns in the customer table.</div>
  `, null, null);
}

registerActions({
  'cf.new':    () => cfNew(),
  'cf.edit':   (ds) => cfEdit(ds.id),
  'cf.delete': (ds) => cfDelete(ds.id),
});

registerChangeActions({
  'cf.filterEntity': (ds, el) => { CF_FILTER_ENTITY = el.value; window.renderPage('custom-fields'); },
  'cf.toggleOptions': (ds, el) => cfFormToggleOptions(el.value),
});
