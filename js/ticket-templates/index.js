// ─── Ticket Templates ────────────────────────────────────────────────────────
// Config-section page for the per-category ticket starter templates that
// the New Ticket modal can prefill from. CRUD only — the template picker
// inside the New Ticket modal lives in app.js (showNewTicketModal +
// ntApplyTemplate) because it's part of the new-ticket form, not this
// Config page.
//
// Click/change/input handlers route through core/event-delegation.js.
// `renderTicketTemplates` is the only export (the app.js router calls
// it).
//
// External reaches (interim, via window): isAdmin, escAttr, escHtml — all
// still in app.js. showModal and closeModal are direct ES imports.
// showNewTicketModal is a direct ES import from tickets/detail.js
// (no cycle — detail.js doesn't import from this module).

import { TICKETS, TICKET_TEMPLATES } from '../core/data.js';
import { TT_FILTER_CAT, setTtFilterCat } from '../core/state.js';
import { renderPage } from '../core/router.js';
import { registerActions, registerChangeActions, registerInputActions } from '../core/event-delegation.js';
import { showNewTicketModal } from '../tickets/detail.js';
import { apiPost, apiPatch, apiDelete } from '../core/api-client.js';
import { showModal, closeModal } from '../core/modal.js';

function ttApiBacked() {
  return TICKET_TEMPLATES.some((t) => t._uuid);
}

function ttMapResponse(r) {
  return {
    _uuid:    r.id,
    id:       r.display_id,
    name:     r.name,
    category: r.category || '',
    priority: r.priority_key || 'normal',
    subject:  r.subject || '',
    body:     r.body || '',
  };
}

let TT_QUERY = '';

export function renderTicketTemplates() {
  const admin = window.isAdmin();
  let list = [...TICKET_TEMPLATES];
  if (TT_FILTER_CAT !== 'all') list = list.filter(t => t.category === TT_FILTER_CAT);
  if (TT_QUERY.trim()) {
    const q = TT_QUERY.toLowerCase();
    list = list.filter(t => t.name.toLowerCase().includes(q) || t.subject.toLowerCase().includes(q) || (t.body||'').toLowerCase().includes(q) || (t.category||'').toLowerCase().includes(q));
  }
  const total = TICKET_TEMPLATES.length;
  const cats = [...new Set(TICKET_TEMPLATES.map(t => t.category))];

  const rows = list.map(t => `
    <tr>
      <td class="bold">${t.id}</td>
      <td style="font-weight:500;color:var(--ink)">${window.escHtml(t.name)}</td>
      <td><span class="tag tag-neutral" style="font-size:10px">${window.escHtml(t.category)}</span></td>
      <td><span class="tag tag-${t.priority}" style="font-size:10px">${t.priority}</span></td>
      <td style="font-size:12px;color:var(--ink2);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(t.subject)}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-sm btn-solid" data-action="ticket-templates.use" data-tt-id="${window.escAttr(t.id)}">Use</button>
        ${admin ? `
          <button class="btn btn-sm" data-action="ticket-templates.edit" data-tt-id="${window.escAttr(t.id)}">Edit</button>
          <button class="btn btn-sm" data-action="ticket-templates.duplicate" data-tt-id="${window.escAttr(t.id)}">Copy</button>
          <button class="btn btn-sm btn-danger" data-action="ticket-templates.delete" data-tt-id="${window.escAttr(t.id)}">Delete</button>` : ''}
      </td>
    </tr>`).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Ticket Templates</div>
        ${admin ? `<button class="btn btn-solid btn-sm" data-action="ticket-templates.new">+ New Template</button>` : ''}
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Templates</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${cats.length}</div><div class="kpi-l">Categories</div></div>
        <div class="kpi"><div class="kpi-n c-red">${TICKET_TEMPLATES.filter(t => t.priority==='urgent' || t.priority==='high').length}</div><div class="kpi-l">High/urgent defaults</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${Math.round(TICKET_TEMPLATES.reduce((s,t)=>s+(t.body||'').length,0)/(total||1))}</div><div class="kpi-l">Avg body chars</div></div>
      </div>
      <div class="filter-bar">
        <span class="filter-label">Filter</span>
        <input class="filter-select" placeholder="Search templates…" style="width:240px" value="${TT_QUERY}" data-input-action="ticket-templates.setQuery" id="tt-search"/>
        <select class="filter-select" data-change-action="ticket-templates.setFilterCat">
          <option value="all" ${TT_FILTER_CAT==='all'?'selected':''}>All categories</option>
          ${cats.map(c => `<option value="${c}" ${TT_FILTER_CAT===c?'selected':''}>${c}</option>`).join('')}
        </select>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${total}</span>
      </div>
      <div class="page-scroll">
        <table class="tbl">
          <thead><tr><th>ID</th><th>Name</th><th>Category</th><th>Priority</th><th>Subject preview</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${list.length===0 ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No templates match</div><div class="empty-line"></div></div>` : ''}
        <div style="margin-top:14px;font-size:11px;color:var(--ink3);line-height:1.5">Click <strong style="color:var(--ink2)">Use</strong> to open the New Ticket modal pre-filled from the template. The same picker is also available inside the regular New Ticket flow.</div>
      </div>
    </div>`;
}

function ttSetQuery(q) {
  TT_QUERY = q;
  renderPage('ticket-templates');
  const input = document.getElementById('tt-search');
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

function ttFormBody(t) {
  const cats = [...new Set([...TICKET_TEMPLATES.map(x => x.category), ...TICKETS.map(x => x.category)])];
  const esc = s => String(s||'').replace(/"/g,'&quot;');
  return `
    <div class="form-row"><label class="form-label">Name</label><input class="form-input" id="tt-name" value="${esc(t?.name)}" placeholder="e.g. Outage report"/></div>
    <div class="form-grid">
      <div class="form-row"><label class="form-label">Category</label>
        <input class="form-input" id="tt-cat" list="tt-cat-list" value="${esc(t?.category)}" placeholder="Account / Billing / Technical…"/>
        <datalist id="tt-cat-list">${cats.map(c => `<option value="${window.escHtml(c)}">`).join('')}</datalist>
      </div>
      <div class="form-row"><label class="form-label">Default priority</label>
        <select class="form-input" id="tt-pri">${['low','normal','high','urgent'].map(p => `<option value="${p}" ${(t?.priority||'normal')===p?'selected':''}>${p}</option>`).join('')}</select>
      </div>
    </div>
    <div class="form-row"><label class="form-label">Subject (template)</label><input class="form-input" id="tt-subj" value="${esc(t?.subject)}" placeholder="Use [placeholders] for fields agents fill in"/></div>
    <div class="form-row"><label class="form-label">Body</label><textarea class="form-input" id="tt-body" style="min-height:140px;font-family:'Inter',sans-serif" placeholder="Initial ticket message or agent guidance">${window.escHtml(t?.body||'')}</textarea></div>`;
}

function ttNextId() {
  const max = Math.max(0, ...TICKET_TEMPLATES.map(x => parseInt((x.id||'').split('-')[1] || '0', 10)));
  return 'TT-' + String(max + 1).padStart(3, '0');
}

function ttNew() {
  if (!window.isAdmin()) return;
  showModal('New ticket template', ttFormBody(null), async () => {
    const name = document.getElementById('tt-name').value.trim();
    const category = document.getElementById('tt-cat').value.trim() || 'General';
    const priority = document.getElementById('tt-pri').value;
    const subject = document.getElementById('tt-subj').value.trim();
    const body = document.getElementById('tt-body').value;
    if (!name || !subject) return;
    if (ttApiBacked()) {
      let resp;
      try { resp = await apiPost('/api/v1/ticket-templates', { name, category, priority_key: priority, subject, body }); }
      catch (err) { alert(`Couldn't create: ${err?.message || err}`); return; }
      TICKET_TEMPLATES.unshift(ttMapResponse(resp.ticket_template));
    } else {
      TICKET_TEMPLATES.unshift({ id: ttNextId(), name, category, priority, subject, body });
    }
    closeModal(); renderPage('ticket-templates');
  }, 'Create');
}

function ttEdit(id) {
  if (!window.isAdmin()) return;
  const t = TICKET_TEMPLATES.find(x => x.id === id); if (!t) return;
  showModal(`Edit ${t.id}`, ttFormBody(t), async () => {
    const name = document.getElementById('tt-name').value.trim();
    const category = document.getElementById('tt-cat').value.trim() || 'General';
    const priority = document.getElementById('tt-pri').value;
    const subject = document.getElementById('tt-subj').value.trim();
    const body = document.getElementById('tt-body').value;
    if (!name || !subject) return;
    if (t._uuid) {
      try { await apiPatch(`/api/v1/ticket-templates/${t._uuid}`, { name, category, priority_key: priority, subject, body }); }
      catch (err) { alert(`Couldn't save: ${err?.message || err}`); return; }
    }
    t.name = name; t.category = category; t.priority = priority; t.subject = subject; t.body = body;
    closeModal(); renderPage('ticket-templates');
  }, 'Save');
}

function ttDuplicate(id) {
  if (!window.isAdmin()) return;
  const orig = TICKET_TEMPLATES.find(x => x.id === id); if (!orig) return;
  (async () => {
    if (orig._uuid) {
      let resp;
      try { resp = await apiPost('/api/v1/ticket-templates', { name: orig.name + ' (copy)', category: orig.category, priority_key: orig.priority, subject: orig.subject, body: orig.body }); }
      catch (err) { alert(`Couldn't duplicate: ${err?.message || err}`); return; }
      TICKET_TEMPLATES.unshift(ttMapResponse(resp.ticket_template));
    } else {
      TICKET_TEMPLATES.unshift({ ...orig, id: ttNextId(), name: orig.name + ' (copy)' });
    }
    renderPage('ticket-templates');
  })();
}

function ttDelete(id) {
  if (!window.isAdmin()) return;
  const t = TICKET_TEMPLATES.find(x => x.id === id); if (!t) return;
  showModal('Delete template', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${window.escHtml(t.name)}</strong>?</div>`, async () => {
    if (t._uuid) {
      try { await apiDelete(`/api/v1/ticket-templates/${t._uuid}`); }
      catch (err) { alert(`Couldn't delete: ${err?.message || err}`); return; }
    }
    const i = TICKET_TEMPLATES.findIndex(x => x.id === id);
    if (i >= 0) TICKET_TEMPLATES.splice(i, 1);
    closeModal(); renderPage('ticket-templates');
  }, 'Delete');
}

registerActions({
  'ticket-templates.new':       () => ttNew(),
  'ticket-templates.edit':      (ds) => ttEdit(ds.ttId),
  'ticket-templates.duplicate': (ds) => ttDuplicate(ds.ttId),
  'ticket-templates.delete':    (ds) => ttDelete(ds.ttId),
  'ticket-templates.use':       (ds) => showNewTicketModal(ds.ttId),
});

registerChangeActions({
  'ticket-templates.setFilterCat': (ds, el) => { setTtFilterCat(el.value); renderPage('ticket-templates'); },
});

registerInputActions({
  'ticket-templates.setQuery': (ds, el) => ttSetQuery(el.value),
});
