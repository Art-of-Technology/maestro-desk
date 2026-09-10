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
import { apiPost, apiPatch, apiDelete, getJwt, getWorkspaceId } from '../core/api-client.js';
import { showModal, closeModal } from '../core/modal.js';
import { mountComposer, disposeComposer, getHtml, getPlainText, setText, insertAtCursor } from './composer.js';

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
        <input class="filter-select" placeholder="Search templates…" style="width:240px" value="${window.escAttr(TPL_QUERY)}" data-input-action="templates.setQuery" id="tpl-search"/>
        <select class="filter-select" data-change-action="templates.setFilterCat">
          <option value="all" ${TPL_FILTER_CAT==='all'?'selected':''}>All categories</option>
          ${cats.map(c => `<option value="${window.escAttr(c)}" ${TPL_FILTER_CAT===c?'selected':''}>${window.escHtml(c)}</option>`).join('')}
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
  const esc = s => window.escAttr(s || '');
  return `
    <div class="form-grid">
      <div class="form-row"><label class="form-label" for="tpl-name">Name</label><input class="form-input" id="tpl-name" value="${esc(t?.name)}" placeholder="e.g. Outage acknowledgement"/></div>
      <div class="form-row"><label class="form-label" for="tpl-cat">Category</label>
        <input class="form-input" id="tpl-cat" list="tpl-cat-list" value="${esc(t?.category)}" placeholder="General"/>
        <datalist id="tpl-cat-list">${cats.map(c => `<option value="${window.escHtml(c)}">`).join('')}</datalist>
      </div>
    </div>
    <div class="form-row">
      <label class="form-label">Body</label>
      <div id="compose-template-editor" data-rich="1" style="min-height:160px"></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px" aria-label="Insert a variable">
        ${['name', 'ticket', 'brand', 'agent'].map(key => `<button type="button" class="btn btn-sm" data-action="templates.variable" data-variable="${key}">{${key}}</button>`).join('')}
      </div>
      <div id="tpl-editor-status" role="status" style="font-size:12px;margin-top:8px">Loading editor…</div>
    </div>`;
}

function tplNextId() {
  const max = Math.max(0, ...CANNED_RESPONSES.map(x => parseInt((x.id||'').split('-')[1] || '0', 10)));
  return 'TPL-' + String(max + 1).padStart(3, '0');
}

function tplApiBacked() {
  return !!getJwt();
}

function tplMapResponse(r) {
  return {
    _uuid:    r.id,
    id:       r.display_id,
    name:     r.name,
    category: r.category || '',
    text:     r.body || '',
    html:     r.body_html || null,
  };
}

function tplNew() {
  tplOpen(null);
}

function tplEdit(id) {
  const t = CANNED_RESPONSES.find(x => x.id === id); if (!t) return;
  tplOpen(t);
}

function tplOpen(t) {
  if (!window.isAdmin()) return;
  const editorId = 'template-editor';
  const workspace = getWorkspaceId();
  const jwt = getJwt();
  let ready = false;
  let saving = false;
  disposeComposer(editorId);
  showModal(t ? `Edit ${t.id}` : 'New template', tplFormBody(t), async () => {
    if (!ready || saving || workspace !== getWorkspaceId() || jwt !== getJwt()) return;
    const name = document.getElementById('tpl-name').value.trim();
    const cat  = document.getElementById('tpl-cat').value.trim() || 'General';
    const text = getPlainText(editorId);
    const html = getHtml(editorId);
    if (!name || (!text.trim() && !html)) {
      status.textContent = 'Enter a name and a template body.';
      return;
    }
    saving = true;
    button.disabled = true;
    try {
      let saved;
      if (tplApiBacked()) {
        const body = { name, category: cat, body: text, body_html: html };
        const response = t?._uuid
          ? await apiPatch(`/api/v1/canned-responses/${t._uuid}`, body)
          : await apiPost('/api/v1/canned-responses', body);
        saved = tplMapResponse(response.canned_response);
      } else saved = { id: t?.id || tplNextId(), name, category: cat, text, html };
      if (workspace !== getWorkspaceId() || jwt !== getJwt()) return;
      if (t) Object.assign(t, saved); else CANNED_RESPONSES.unshift(saved);
      if (document.getElementById('tpl-name') === nameInput) {
        disposeComposer(editorId);
        closeModal(); renderPage('templates');
      }
    } catch (err) {
      if (status.isConnected) status.textContent = `Couldn't save: ${err?.message || err}`;
    } finally {
      saving = false;
      if (button.isConnected) button.disabled = false;
    }
  }, t ? 'Save' : 'Create', true);
  const nameInput = document.getElementById('tpl-name');
  const host = document.getElementById('compose-' + editorId);
  const status = document.getElementById('tpl-editor-status');
  const button = document.querySelector('#modal-container [data-action="modal.confirm"]');
  button.disabled = true;
  mountComposer(editorId, { initialHtml: t?.html, placeholder: 'Write a response…' }).catch(() => null).then(q => {
    if (document.getElementById('tpl-name') !== nameInput) return;
    if (q) {
      q.root.setAttribute('role', 'textbox');
      q.root.setAttribute('aria-label', 'Template body');
      q.root.setAttribute('aria-multiline', 'true');
      if (!t?.html) setText(editorId, t?.text || '');
      status.textContent = 'Variables fill in when you insert the response into a ticket.';
    } else {
      const fallback = document.createElement('textarea');
      fallback.id = host.id;
      fallback.className = 'form-input';
      fallback.style.minHeight = '160px';
      fallback.value = t?.text || '';
      fallback.setAttribute('aria-label', 'Template body');
      host.replaceWith(fallback);
      status.textContent = 'Rich editor unavailable. Saving will use plain text.';
    }
    ready = true;
    button.disabled = false;
  });
}

function tplDuplicate(id) {
  if (!window.isAdmin()) return;
  const orig = CANNED_RESPONSES.find(x => x.id === id); if (!orig) return;
  (async () => {
    if (orig._uuid) {
      let resp;
      try { resp = await apiPost('/api/v1/canned-responses', { name: orig.name + ' (copy)', category: orig.category, body: orig.text, body_html: orig.html || null }); }
      catch (err) { alert(`Couldn't duplicate: ${err?.message || err}`); return; }
      CANNED_RESPONSES.unshift(tplMapResponse(resp.canned_response));
    } else {
      CANNED_RESPONSES.unshift({ id:tplNextId(), name:orig.name + ' (copy)', category:orig.category, text:orig.text, html:orig.html || null });
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
  'templates.variable': (ds) => {
    if (['name', 'ticket', 'brand', 'agent'].includes(ds.variable)) insertAtCursor('template-editor', `{${ds.variable}}`);
  },
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
