// ─── Ticket Templates ────────────────────────────────────────────────────────
// Config-section page for the per-category ticket starter templates that
// the New Ticket modal can prefill from. CRUD only — the template picker
// inside the New Ticket modal lives in app.js (showNewTicketModal +
// ntApplyTemplate) because it's part of the new-ticket form, not this
// Config page.
//
// External reaches (interim, via window): isAdmin, escAttr, escHtml,
// showModal, closeModal, renderPage, showNewTicketModal — all still in app.js.
//
// TICKET_TEMPLATES and TICKETS come from data.js via the global lexical env;
// TT_FILTER_CAT comes from core/state.js the same way.

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
        <button class="btn btn-sm btn-solid" onclick="showNewTicketModal('${window.escAttr(t.id)}')">Use</button>
        ${admin ? `
          <button class="btn btn-sm" onclick="ttEdit('${window.escAttr(t.id)}')">Edit</button>
          <button class="btn btn-sm" onclick="ttDuplicate('${window.escAttr(t.id)}')">Copy</button>
          <button class="btn btn-sm btn-danger" onclick="ttDelete('${window.escAttr(t.id)}')">Delete</button>` : ''}
      </td>
    </tr>`).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Ticket Templates</div>
        ${admin ? `<button class="btn btn-solid btn-sm" onclick="ttNew()">+ New Template</button>` : ''}
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Templates</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${cats.length}</div><div class="kpi-l">Categories</div></div>
        <div class="kpi"><div class="kpi-n c-red">${TICKET_TEMPLATES.filter(t => t.priority==='urgent' || t.priority==='high').length}</div><div class="kpi-l">High/urgent defaults</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${Math.round(TICKET_TEMPLATES.reduce((s,t)=>s+(t.body||'').length,0)/(total||1))}</div><div class="kpi-l">Avg body chars</div></div>
      </div>
      <div class="filter-bar">
        <span class="filter-label">Filter</span>
        <input class="filter-select" placeholder="Search templates…" style="width:240px" value="${TT_QUERY}" oninput="ttSetQuery(this.value)" id="tt-search"/>
        <select class="filter-select" onchange="TT_FILTER_CAT=this.value;renderPage('ticket-templates')">
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

export function ttSetQuery(q) {
  TT_QUERY = q;
  window.renderPage('ticket-templates');
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

export function ttNew() {
  if (!window.isAdmin()) return;
  window.showModal('New ticket template', ttFormBody(null), () => {
    const name = document.getElementById('tt-name').value.trim();
    const category = document.getElementById('tt-cat').value.trim() || 'General';
    const priority = document.getElementById('tt-pri').value;
    const subject = document.getElementById('tt-subj').value.trim();
    const body = document.getElementById('tt-body').value;
    if (!name || !subject) return;
    TICKET_TEMPLATES.unshift({ id: ttNextId(), name, category, priority, subject, body });
    window.closeModal(); window.renderPage('ticket-templates');
  }, 'Create');
}

export function ttEdit(id) {
  if (!window.isAdmin()) return;
  const t = TICKET_TEMPLATES.find(x => x.id === id); if (!t) return;
  window.showModal(`Edit ${t.id}`, ttFormBody(t), () => {
    const name = document.getElementById('tt-name').value.trim();
    const category = document.getElementById('tt-cat').value.trim() || 'General';
    const priority = document.getElementById('tt-pri').value;
    const subject = document.getElementById('tt-subj').value.trim();
    const body = document.getElementById('tt-body').value;
    if (!name || !subject) return;
    t.name = name; t.category = category; t.priority = priority; t.subject = subject; t.body = body;
    window.closeModal(); window.renderPage('ticket-templates');
  }, 'Save');
}

export function ttDuplicate(id) {
  if (!window.isAdmin()) return;
  const orig = TICKET_TEMPLATES.find(x => x.id === id); if (!orig) return;
  TICKET_TEMPLATES.unshift({ ...orig, id: ttNextId(), name: orig.name + ' (copy)' });
  window.renderPage('ticket-templates');
}

export function ttDelete(id) {
  if (!window.isAdmin()) return;
  const t = TICKET_TEMPLATES.find(x => x.id === id); if (!t) return;
  window.showModal('Delete template', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${window.escHtml(t.name)}</strong>?</div>`, () => {
    const i = TICKET_TEMPLATES.findIndex(x => x.id === id);
    if (i >= 0) TICKET_TEMPLATES.splice(i, 1);
    window.closeModal(); window.renderPage('ticket-templates');
  }, 'Delete');
}
