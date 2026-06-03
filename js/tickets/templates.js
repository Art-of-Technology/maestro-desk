// ─── Response templates ──────────────────────────────────────────────────────
// Admin-managed library of canned reply texts. Agents pick one from the
// composer's "Insert canned response" panel; macros (tickets/macros.js)
// reference them by id for reply-step actions.
//
// Click/change/input handlers route through core/event-delegation.js.
// `renderTemplates` is the only export (the app.js router calls it).
//
// External reaches (interim, via window): isAdmin, escHtml, escAttr — all
// still in app.js. showModal and closeModal are direct ES imports.

import { CANNED_RESPONSES } from '../core/data.js';
import { TPL_FILTER_CAT, TPL_QUERY, setTplFilterCat, setTplQuery } from '../core/state.js';
import { renderPage } from '../core/router.js';
import { registerActions, registerChangeActions, registerInputActions } from '../core/event-delegation.js';
import { apiPost, apiPatch, apiDelete } from '../core/api-client.js';
import { showModal, closeModal } from '../core/modal.js';

export function renderTemplates() {
  const admin = window.isAdmin();
  let list = [...CANNED_RESPONSES];
  if (TPL_FILTER_CAT !== 'all') list = list.filter(t => t.category === TPL_FILTER_CAT);
  if (TPL_QUERY.trim()) {
    const q = TPL_QUERY.toLowerCase();
    list = list.filter(t => t.name.toLowerCase().includes(q) || t.text.toLowerCase().includes(q) || (t.category||'').toLowerCase().includes(q));
  }
  const total = CANNED_RESPONSES.length;
  const cats = [...new Set(CANNED_RESPONSES.map(t => t.category || 'Uncategorised'))];

  const rows = list.map(t => {
    const preview = (t.text || '').replace(/\n+/g, ' ').slice(0, 120);
    return `<tr>
      <td class="bold">${window.escHtml(t.id)}</td>
      <td style="font-weight:500;color:var(--ink)">${window.escHtml(t.name)}</td>
      <td><span class="tag tag-neutral" style="font-size:10px">${window.escHtml(t.category||'—')}</span></td>
      <td style="font-size:12px;color:var(--ink2);max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(preview)}</td>
      ${admin ? `<td style="text-align:right;white-space:nowrap">
        <button class="btn btn-sm" data-action="templates.edit" data-tpl-id="${window.escAttr(t.id)}">Edit</button>
        <button class="btn btn-sm" data-action="templates.duplicate" data-tpl-id="${window.escAttr(t.id)}">Copy</button>
        <button class="btn btn-sm btn-danger" data-action="templates.delete" data-tpl-id="${window.escAttr(t.id)}">Delete</button>
      </td>` : ''}
    </tr>`;
  }).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Response Templates</div>
        ${admin
          ? `<button class="btn btn-solid btn-sm" data-action="templates.new">+ New Template</button>`
          : `<span style="font-size:11px;color:var(--ink3);font-style:italic">Read-only — admin access required to edit</span>`}
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Templates</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${cats.length}</div><div class="kpi-l">Categories</div></div>
        <div class="kpi"><div class="kpi-n c-purple">${CANNED_RESPONSES.filter(t => /\{name\}|\{ticket\}|\{brand\}|\{agent\}/.test(t.text||'')).length}</div><div class="kpi-l">With variables</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${Math.round(CANNED_RESPONSES.reduce((s,t)=>s+(t.text||'').length,0)/(total||1))}</div><div class="kpi-l">Avg chars</div></div>
      </div>
      <div class="filter-bar">
        <span class="filter-label">Filter</span>
        <input class="filter-select" placeholder="Search templates…" style="width:240px" value="${TPL_QUERY}" data-input-action="templates.setQuery" id="tpl-search"/>
        <select class="filter-select" data-change-action="templates.setFilterCat">
          <option value="all" ${TPL_FILTER_CAT==='all'?'selected':''}>All categories</option>
          ${cats.map(c => `<option value="${c}" ${TPL_FILTER_CAT===c?'selected':''}>${c}</option>`).join('')}
        </select>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${total}</span>
      </div>
      <div class="page-scroll">
        <table class="tbl">
          <thead><tr>
            <th>ID</th><th>Name</th><th>Category</th><th>Preview</th>
            ${admin?'<th style="text-align:right">Actions</th>':''}
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${list.length===0 ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No templates match</div><div class="empty-line"></div></div>` : ''}
        <div style="margin-top:14px;font-size:11px;color:var(--ink3);line-height:1.5">Variables auto-fill at insert time: <code style="font-family:'DM Mono',monospace;font-size:11px">{name}</code> = customer first name, <code style="font-family:'DM Mono',monospace;font-size:11px">{ticket}</code> = ticket id, <code style="font-family:'DM Mono',monospace;font-size:11px">{brand}</code> = customer brand, <code style="font-family:'DM Mono',monospace;font-size:11px">{agent}</code> = assigned agent.</div>
      </div>
    </div>`;
}

function tplSetQuery(q) {
  setTplQuery(q);
  renderPage('templates');
  const input = document.getElementById('tpl-search');
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

function tplFormBody(t) {
  const cats = [...new Set(CANNED_RESPONSES.map(x => x.category || 'General'))];
  const esc = s => String(s||'').replace(/"/g,'&quot;');
  return `
    <div class="form-grid">
      <div class="form-row"><label class="form-label">Name</label><input class="form-input" id="tpl-name" value="${esc(t?.name)}" placeholder="e.g. Outage acknowledgement"/></div>
      <div class="form-row"><label class="form-label">Category</label>
        <input class="form-input" id="tpl-cat" list="tpl-cat-list" value="${esc(t?.category)}" placeholder="General"/>
        <datalist id="tpl-cat-list">${cats.map(c => `<option value="${window.escHtml(c)}">`).join('')}</datalist>
      </div>
    </div>
    <div class="form-row">
      <label class="form-label">Body</label>
      <textarea class="form-input" id="tpl-text" style="min-height:160px;font-family:'Inter',sans-serif" placeholder="Write the template body. Use {name}, {ticket}, {brand}, {agent} for variables.">${window.escHtml(t?.text || '')}</textarea>
    </div>`;
}

function tplNextId() {
  const max = Math.max(0, ...CANNED_RESPONSES.map(x => parseInt((x.id||'').split('-')[1] || '0', 10)));
  return 'TPL-' + String(max + 1).padStart(3, '0');
}

function tplApiBacked() {
  return CANNED_RESPONSES.some((t) => t._uuid);
}

function tplMapResponse(r) {
  return {
    _uuid:    r.id,
    id:       r.display_id,
    name:     r.name,
    category: r.category || '',
    text:     r.body || '',
  };
}

function tplNew() {
  if (!window.isAdmin()) return;
  showModal('New template', tplFormBody(null), async () => {
    const name = document.getElementById('tpl-name').value.trim();
    const cat  = document.getElementById('tpl-cat').value.trim() || 'General';
    const text = document.getElementById('tpl-text').value;
    if (!name || !text.trim()) return;
    if (tplApiBacked()) {
      let resp;
      try { resp = await apiPost('/api/v1/canned-responses', { name, category: cat, body: text }); }
      catch (err) { alert(`Couldn't create: ${err?.message || err}`); return; }
      CANNED_RESPONSES.unshift(tplMapResponse(resp.canned_response));
    } else {
      CANNED_RESPONSES.unshift({ id: tplNextId(), name, category:cat, text });
    }
    closeModal(); renderPage('templates');
  }, 'Create');
}

function tplEdit(id) {
  if (!window.isAdmin()) return;
  const t = CANNED_RESPONSES.find(x => x.id === id); if (!t) return;
  showModal(`Edit ${t.id}`, tplFormBody(t), async () => {
    const name = document.getElementById('tpl-name').value.trim();
    const cat  = document.getElementById('tpl-cat').value.trim() || 'General';
    const text = document.getElementById('tpl-text').value;
    if (!name || !text.trim()) return;
    if (t._uuid) {
      try { await apiPatch(`/api/v1/canned-responses/${t._uuid}`, { name, category: cat, body: text }); }
      catch (err) { alert(`Couldn't save: ${err?.message || err}`); return; }
    }
    t.name = name; t.category = cat; t.text = text;
    closeModal(); renderPage('templates');
  }, 'Save');
}

function tplDuplicate(id) {
  if (!window.isAdmin()) return;
  const orig = CANNED_RESPONSES.find(x => x.id === id); if (!orig) return;
  (async () => {
    if (orig._uuid) {
      let resp;
      try { resp = await apiPost('/api/v1/canned-responses', { name: orig.name + ' (copy)', category: orig.category, body: orig.text }); }
      catch (err) { alert(`Couldn't duplicate: ${err?.message || err}`); return; }
      CANNED_RESPONSES.unshift(tplMapResponse(resp.canned_response));
    } else {
      CANNED_RESPONSES.unshift({ id:tplNextId(), name:orig.name + ' (copy)', category:orig.category, text:orig.text });
    }
    renderPage('templates');
  })();
}

function tplDelete(id) {
  if (!window.isAdmin()) return;
  const t = CANNED_RESPONSES.find(x => x.id === id); if (!t) return;
  showModal('Delete template', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${window.escHtml(t.name)}</strong>?</div>`, async () => {
    if (t._uuid) {
      try { await apiDelete(`/api/v1/canned-responses/${t._uuid}`); }
      catch (err) { alert(`Couldn't delete: ${err?.message || err}`); return; }
    }
    const i = CANNED_RESPONSES.findIndex(x => x.id === id);
    if (i >= 0) CANNED_RESPONSES.splice(i, 1);
    closeModal(); renderPage('templates');
  }, 'Delete');
}

registerActions({
  'templates.new':       () => tplNew(),
  'templates.edit':      (ds) => tplEdit(ds.tplId),
  'templates.duplicate': (ds) => tplDuplicate(ds.tplId),
  'templates.delete':    (ds) => tplDelete(ds.tplId),
});

registerChangeActions({
  'templates.setFilterCat': (ds, el) => { setTplFilterCat(el.value); renderPage('templates'); },
});

registerInputActions({
  'templates.setQuery': (ds, el) => tplSetQuery(el.value),
});
