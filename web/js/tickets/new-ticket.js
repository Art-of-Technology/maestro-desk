// ─── New Ticket modal ────────────────────────────────────────────────────────
// The create-ticket flow, extracted from tickets/detail.js (which keeps the
// per-ticket detail view). Entry points: the tickets list "+ New Ticket"
// button, the ticket-templates page "Use" action, and the customer profile.
//
// External reaches (interim, via window): escAttr, escHtml — still in app.js.

import { AGENTS, CATEGORIES, TICKETS, TICKET_TEMPLATES } from '../core/data.js';
import { SESSION } from '../core/state.js';
import { renderPage } from '../core/router.js';
import { showModal, closeModal } from '../core/modal.js';
import { registerChangeActions } from '../core/event-delegation.js';
import { isFieldRequired, isFieldVisible } from '../layouts/index.js';
import { isAgentOOO, applyAssignmentRules } from './assignment-rules.js';
import { refreshTicketSLA } from './sla.js';
import { fireWebhook, ticketPayload } from '../webhooks/index.js';

export function showNewTicketModal(templateId) {
  // Prefer the workspace's canonical active categories (loaded from the API);
  // fall back to deriving from existing tickets/templates when CATEGORIES is
  // empty (demo persona, which never calls loadWorkspaceData).
  const activeCats = CATEGORIES.filter(c => c.is_active).map(c => c.label);
  const cats = activeCats.length
    ? activeCats
    : [...new Set([...TICKETS.map(t=>t.category), ...TICKET_TEMPLATES.map(t=>t.category)])].filter(Boolean);
  const tpl = templateId ? TICKET_TEMPLATES.find(t => t.id === templateId) : null;
  const esc = s => String(s||'').replace(/"/g,'&quot;');
  const tplOptions = TICKET_TEMPLATES.map(t => `<option value="${window.escAttr(t.id)}" ${tpl?.id===t.id?'selected':''}>${window.escHtml(t.name)}</option>`).join('');
  const req = key => isFieldRequired('ticket', key) ? ' <span style="color:var(--red);font-weight:500" title="Required">*</span>' : '';
  const visible = key => isFieldVisible('ticket', key);
  const customerRow = visible('customerId')
    ? `<div class="form-row"><label class="form-label">Customer ID${req('customerId')}</label><input class="form-input" id="nt-cust" placeholder="M001"/></div>`
    : '';
  const categoryRow = visible('category')
    ? `<div class="form-row"><label class="form-label">Category${req('category')}</label>
        <select class="form-input" id="nt-cat">
          <option value="" disabled hidden ${tpl?.category && cats.includes(tpl.category) ? '' : 'selected'}>Select a category…</option>
          ${cats.map(c=>`<option ${tpl?.category===c?'selected':''}>${window.escHtml(c)}</option>`).join('')}
        </select>
      </div>`
    : '';
  const priorityRow = visible('priority')
    ? `<div class="form-row"><label class="form-label">Priority${req('priority')}</label>
        <select class="form-input" id="nt-pri">${['normal','high','urgent','low'].map(p => `<option ${tpl?.priority===p?'selected':''}>${p}</option>`).join('')}</select>
      </div>`
    : '';
  const agentRow = visible('agent')
    ? `<div class="form-row"><label class="form-label">Assign to${req('agent')}</label>
        <select class="form-input" id="nt-agent">
          <option value="__auto__">Auto (apply rules)</option>
          ${AGENTS.map(a=>`<option value="${window.escAttr(a.name)}">${window.escHtml(a.name)}${isAgentOOO(a.name) ? ' (OOO)' : ''}</option>`).join('')}
        </select>
      </div>`
    : '';
  const messageRow = visible('message')
    ? `<div class="form-row"><label class="form-label">Message${req('message')}</label><textarea class="form-input" id="nt-msg" placeholder="First message…">${window.escHtml(tpl?.body || '')}</textarea></div>`
    : '';
  showModal('New Ticket', `
    ${TICKET_TEMPLATES.length ? `
    <div class="form-row">
      <label class="form-label">Start from template (optional)</label>
      <select class="form-input" id="nt-template" data-change-action="nt.applyTemplate">
        <option value="">— Blank ticket —</option>
        ${tplOptions}
      </select>
    </div>` : ''}
    ${customerRow || categoryRow ? `<div class="form-grid">${customerRow}${categoryRow}</div>` : ''}
    ${visible('subject') ? `<div class="form-row"><label class="form-label">Subject${req('subject')}</label><input class="form-input" id="nt-subj" value="${esc(tpl?.subject)}" placeholder="Describe the issue…"/></div>` : ''}
    ${priorityRow || agentRow ? `<div class="form-grid">${priorityRow}${agentRow}</div>` : ''}
    ${messageRow}
  `, () => {
    const subj = document.getElementById('nt-subj')?.value.trim() || '';
    if (visible('subject') && isFieldRequired('ticket', 'subject') && !subj) { alert('Subject is required.'); return; }
    const custInput = document.getElementById('nt-cust');
    const custId = custInput ? (custInput.value.trim() || 'M001') : 'M001';
    if (visible('customerId') && isFieldRequired('ticket', 'customerId') && !custInput?.value.trim()) {
      alert('Customer is required.'); return;
    }
    const msgEl = document.getElementById('nt-msg');
    const msg = msgEl ? msgEl.value.trim() : '';
    if (visible('message') && isFieldRequired('ticket', 'message') && !msg) {
      alert('First message is required.'); return;
    }
    // Category is compulsory (also locked required in FIELD_LAYOUTS) —
    // agents must actively pick an accurate one. A workspace with no
    // categories at all has nothing to pick, so don't dead-end it.
    if (visible('category') && cats.length && !document.getElementById('nt-cat')?.value) {
      alert('Please select a category.'); return;
    }
    if (visible('priority') && isFieldRequired('ticket', 'priority') && !document.getElementById('nt-pri')?.value) {
      alert('Priority is required.'); return;
    }
    if (visible('agent') && isFieldRequired('ticket', 'agent')) {
      const v = document.getElementById('nt-agent')?.value;
      if (!v || v === '__auto__') { alert('Assignee is required (Auto does not satisfy a required assignment).'); return; }
    }
    // parseInt on non-numeric IDs returns NaN; filter them out so a stray
    // ticket like "TK-foo" can't poison Math.max into NaN.
    const ticketNums = TICKETS.map(t => parseInt((t.id||'').split('-')[1] || '0', 10)).filter(n => Number.isFinite(n));
    const newId = 'TK-' + String(Math.max(0, ...ticketNums) + 1).padStart(3,'0');
    const agentPick = document.getElementById('nt-agent')?.value || '__auto__';
    TICKETS.unshift({
      id:newId, subject:subj, customerId:custId,
      status:'open',
      priority: document.getElementById('nt-pri')?.value || 'normal',
      // Falls through only when the workspace has no categories (the guard
      // above never lets an empty pick past otherwise).
      category: document.getElementById('nt-cat')?.value || cats[0] || 'General',
      agent:agentPick === '__auto__' ? '' : agentPick,
      created:new Date().toISOString().slice(0,10), updated:'just now',
      sla:'ok', tags:[], aiTags:[], csat:null,
      msgs: msg ? [{from:SESSION.name,r:'agent',t:msg,ts:new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}] : [],
    });
    if (agentPick === '__auto__') applyAssignmentRules(TICKETS[0]);
    refreshTicketSLA(TICKETS[0]);
    fireWebhook('ticket.created', ticketPayload(TICKETS[0]));
    closeModal(); renderPage('tickets');
  }, 'Create Ticket');
}

function ntApplyTemplate(id) {
  const t = id ? TICKET_TEMPLATES.find(x => x.id === id) : null;
  const subj = document.getElementById('nt-subj');
  const cat  = document.getElementById('nt-cat');
  const pri  = document.getElementById('nt-pri');
  const msg  = document.getElementById('nt-msg');
  if (!t) {
    if (subj) subj.value = '';
    if (msg) msg.value = '';
    // Back to the placeholder — a category set by a previously-picked
    // template must not silently ride along on a blank ticket.
    if (cat) cat.value = '';
    return;
  }
  if (subj) subj.value = t.subject || '';
  if (msg) msg.value = t.body || '';
  if (cat) {
    // The template's category if it's a real option; otherwise reset to the
    // placeholder so validation forces an active pick (no stale carryover).
    cat.value = (t.category && [...cat.options].some(o => o.value === t.category)) ? t.category : '';
  }
  if (pri && t.priority) pri.value = t.priority;
}

registerChangeActions({
  'nt.applyTemplate': (ds, el) => ntApplyTemplate(el.value),
});
