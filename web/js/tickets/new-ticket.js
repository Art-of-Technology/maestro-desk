// ─── New Ticket flow (two-step) ──────────────────────────────────────────────
// Step 1 collects the compulsory details — customer (typeahead over the
// loaded CUSTOMERS array), category (KEYS as values), subject, priority,
// assignee. Step 2 is the drafting window: templates append, Send emails the
// message to the customer exactly like a reply, Save-as-draft creates the
// ticket and keeps the text as a local composer draft, Cancel discards
// everything. THE TICKET IS ONLY CREATED AT THE END OF STEP 2 (or at step 1's
// confirm when the layout hides the message field entirely).
//
// Real workspaces persist via POST /api/v1/tickets (full post-rules row in
// the response → upserted locally) + POST /:id/messages for Send. Demo
// personas (picked customer has no _uuid) keep the legacy in-memory mint.
//
// One modal at a time (core/modal.js): each step is its own showModal call,
// state carried in the module-local NT object (merge-chain pattern). NT is
// reset on every fresh open, on finish, and on the explicit Cancel.
//
// External reaches (interim, via window): escAttr, escHtml — still in app.js.

import { AGENTS, CATEGORIES, CUSTOMERS, TICKETS, TICKET_TEMPLATES } from '../core/data.js';
import { SESSION, setComposeTabValue } from '../core/state.js';
import { updateNavBadges } from '../core/router.js';
import { showModal, closeModal } from '../core/modal.js';
import { registerActions, registerChangeActions, registerInputActions, registerMousedownActions } from '../core/event-delegation.js';
import { isFieldRequired, isFieldVisible } from '../layouts/index.js';
import { isAgentOOO, applyAssignmentRules } from './assignment-rules.js';
import { refreshTicketSLA } from './sla.js';
import { fireWebhook, ticketPayload } from '../webhooks/index.js';
import { apiPost, apiPatch } from '../core/api-client.js';
import { updateOrInsertTicket } from '../core/bootstrap.js';
import { openTicket, notifyReplyDelivery } from './detail.js';
import { saveDraftFor } from './drafts.js';
import { showToast } from '../core/toast.js';

// ─── Wizard state ────────────────────────────────────────────────────────────
// Survives the closeModal()+showModal() hop between steps; nothing here is
// persisted — the server (or the demo mint) only runs at the very end.
const NT = {
  busy: false,
  templateId: null,
  customer: null,        // { uuid|null, displayId, label }
  categoryValue: '',     // category KEY (API-backed) or label (demo fallback)
  categoryLabel: '',
  subject: '',
  priority: 'normal',
  agentName: '__auto__',
  message: '',
};

function resetNT() {
  NT.busy = false;
  NT.templateId = null;
  NT.customer = null;
  NT.categoryValue = '';
  NT.categoryLabel = '';
  NT.subject = '';
  NT.priority = 'normal';
  NT.agentName = '__auto__';
  NT.message = '';
}

const visible = key => isFieldVisible('ticket', key);
const required = key => isFieldRequired('ticket', key);
const reqMark = key => required(key) ? ' <span style="color:var(--red);font-weight:500" title="Required">*</span>' : '';

// Category options: API-backed workspaces use immutable KEYS as values (what
// POST /tickets expects — the old modal wrongly sent labels); the demo
// fallback derives labels from seed data and uses them as both.
function catOptions() {
  const active = CATEGORIES.filter(c => c.is_active);
  if (active.length) return active.map(c => ({ value: c.key, label: c.label }));
  return [...new Set([...TICKETS.map(t => t.category), ...TICKET_TEMPLATES.map(t => t.category)])]
    .filter(Boolean).map(l => ({ value: l, label: l }));
}

// Templates store category as a FREE STRING — match it case-insensitively
// against both label and key; no match → '' (placeholder forces a pick).
function matchTemplateCategory(tplCategory) {
  if (!tplCategory) return null;
  const want = String(tplCategory).toLowerCase();
  return catOptions().find(o => o.value.toLowerCase() === want || o.label.toLowerCase() === want) || null;
}

// ─── Entry point ─────────────────────────────────────────────────────────────
// templateId: prefill from a ticket template (ticket-templates page "Use").
// custDisplayId: prefill the customer (customer-profile "New ticket" button).
export function showNewTicketModal(templateId, custDisplayId) {
  resetNT();
  if (templateId) applyTemplateToNT(templateId);
  if (custDisplayId) {
    const c = CUSTOMERS.find(x => x.id === custDisplayId && !x.mergedInto);
    if (c) NT.customer = customerRef(c);
  }
  renderStep1();
}

function customerRef(c) {
  return { uuid: c._uuid || null, displayId: c.id, label: `${c.first} ${c.last}`.trim() || c.id };
}

function applyTemplateToNT(id) {
  NT.templateId = id || null;
  const t = id ? TICKET_TEMPLATES.find(x => x.id === id) : null;
  if (!t) { NT.subject = ''; NT.message = ''; NT.categoryValue = ''; NT.categoryLabel = ''; return; }
  NT.subject = t.subject || '';
  NT.message = t.body || '';
  if (t.priority) NT.priority = t.priority;
  const cat = matchTemplateCategory(t.category);
  NT.categoryValue = cat ? cat.value : '';
  NT.categoryLabel = cat ? cat.label : '';
}

// ─── Step 1 — details ────────────────────────────────────────────────────────

function custBoxHtml() {
  if (NT.customer) {
    return `
      <span class="tag" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:6px 10px;background:var(--purple-lt);color:var(--purple);border:1px solid var(--purple)">
        ${window.escHtml(NT.customer.label)}
        <span style="font-family:'DM Mono',monospace;font-size:10px;opacity:.75">${window.escHtml(NT.customer.displayId)}</span>
        <button data-action="nt.clearCust" title="Change customer" style="background:transparent;border:none;color:inherit;cursor:pointer;font-size:13px;line-height:1;padding:0 2px">×</button>
      </span>`;
  }
  return `
    <input class="form-input" id="nt-cust-search" data-input-action="nt.custSearch"
           placeholder="Search by name, email, or ID…" autocomplete="off" spellcheck="false"/>
    <div id="nt-cust-sug" style="position:relative"></div>`;
}

function renderStep1() {
  const cats = catOptions();
  const tplOptions = TICKET_TEMPLATES.map(t =>
    `<option value="${window.escAttr(t.id)}" ${NT.templateId === t.id ? 'selected' : ''}>${window.escHtml(t.name)}</option>`).join('');
  const singleStep = !visible('message');

  const customerRow = visible('customerId')
    ? `<div class="form-row"><label class="form-label">Customer${reqMark('customerId')}</label><div id="nt-cust-box">${custBoxHtml()}</div></div>`
    : '';
  const categoryRow = visible('category')
    ? `<div class="form-row"><label class="form-label">Category${reqMark('category')}</label>
        <select class="form-input" id="nt-cat">
          <option value="" disabled hidden ${NT.categoryValue ? '' : 'selected'}>Select a category…</option>
          ${cats.map(o => `<option value="${window.escAttr(o.value)}" ${NT.categoryValue === o.value ? 'selected' : ''}>${window.escHtml(o.label)}</option>`).join('')}
        </select>
      </div>`
    : '';
  const priorityRow = visible('priority')
    ? `<div class="form-row"><label class="form-label">Priority${reqMark('priority')}</label>
        <select class="form-input" id="nt-pri">${['normal', 'high', 'urgent', 'low'].map(p => `<option ${NT.priority === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
      </div>`
    : '';
  const agentRow = visible('agent')
    ? `<div class="form-row"><label class="form-label">Assign to${reqMark('agent')}</label>
        <select class="form-input" id="nt-agent">
          <option value="__auto__" ${NT.agentName === '__auto__' ? 'selected' : ''}>Auto (apply rules)</option>
          ${AGENTS.map(a => `<option value="${window.escAttr(a.name)}" ${NT.agentName === a.name ? 'selected' : ''}>${window.escHtml(a.name)}${isAgentOOO(a.name) ? ' (OOO)' : ''}</option>`).join('')}
        </select>
      </div>`
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
    ${customerRow}
    ${visible('subject') ? `<div class="form-row"><label class="form-label">Subject${reqMark('subject')}</label><input class="form-input" id="nt-subj" value="${window.escAttr(NT.subject)}" placeholder="Describe the issue…"/></div>` : ''}
    ${categoryRow || priorityRow ? `<div class="form-grid">${categoryRow}${priorityRow}</div>` : ''}
    ${agentRow}
  `, () => {
    if (NT.busy) return;
    harvestStep1();
    if (!validateStep1(cats.length)) return;   // early-return keeps the modal open
    if (singleStep) { void finishCreate({ message: '', send: false }); return; }
    closeModal();
    renderStep2();
  }, singleStep ? 'Create ticket' : 'Next — write the message');

  wireCustomerSearch();
}

function harvestStep1() {
  NT.subject = document.getElementById('nt-subj')?.value.trim() ?? NT.subject;
  const catSel = document.getElementById('nt-cat');
  if (catSel) {
    NT.categoryValue = catSel.value || '';
    NT.categoryLabel = catSel.selectedOptions[0]?.textContent || '';
  }
  NT.priority = document.getElementById('nt-pri')?.value || NT.priority;
  NT.agentName = document.getElementById('nt-agent')?.value || NT.agentName;
}

function validateStep1(haveCats) {
  if (visible('customerId') && !NT.customer) { alert('Pick a customer — search by name, email, or ID.'); return false; }
  if (visible('subject') && required('subject') && !NT.subject) { alert('Subject is required.'); return false; }
  // Category is compulsory (locked required in FIELD_LAYOUTS) — agents must
  // actively pick an accurate one. A workspace with no categories at all has
  // nothing to pick, so don't dead-end it.
  if (visible('category') && haveCats && !NT.categoryValue) { alert('Please select a category.'); return false; }
  if (visible('priority') && required('priority') && !NT.priority) { alert('Priority is required.'); return false; }
  if (visible('agent') && required('agent') && NT.agentName === '__auto__') {
    alert('Assignee is required (Auto does not satisfy a required assignment).'); return false;
  }
  return true;
}

// ─── Customer typeahead ──────────────────────────────────────────────────────
// Client-side filter over the fully-loaded CUSTOMERS array (unpaginated),
// global-search recipe: rows pick on MOUSEDOWN so the choice beats the
// input's blur; keyboard nav is wired imperatively post-render.

function matchCustomers(q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return CUSTOMERS.filter(c => !c.mergedInto && (
    (c.id || '').toLowerCase().includes(needle) ||
    `${c.first} ${c.last}`.toLowerCase().includes(needle) ||
    (c.email || '').toLowerCase().includes(needle) ||
    (c.username || '').toLowerCase().includes(needle)
  )).slice(0, 8);
}

function renderSuggestions(q) {
  const box = document.getElementById('nt-cust-sug');
  if (!box) return;
  const rows = matchCustomers(q);
  if (!rows.length) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="nt-sug" style="position:absolute;top:2px;left:0;right:0;z-index:30;background:var(--w,#fff);border:1px solid var(--rule);border-radius:var(--r);box-shadow:0 8px 24px rgba(19,14,48,.12);overflow:hidden">
      ${rows.map((c, i) => `
        <div class="nt-sug-row ${i === 0 ? 'active' : ''}" data-mousedown-action="nt.pick" data-cust-id="${window.escAttr(c.id)}"
             style="display:flex;gap:10px;align-items:center;padding:8px 12px;cursor:pointer">
          <div style="width:26px;height:26px;border-radius:50%;background:var(--ink);color:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;flex-shrink:0">${window.escHtml((c.first?.[0] || '') + (c.last?.[0] || ''))}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:12.5px;font-weight:500;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(`${c.first} ${c.last}`.trim() || c.id)}</div>
            <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(c.id)}${c.email ? ` · ${window.escHtml(c.email)}` : ''}</div>
          </div>
        </div>`).join('')}
    </div>`;
  // Highlight-follows-hover keeps mouse and keyboard selection in sync.
  box.querySelectorAll('.nt-sug-row').forEach(el => {
    el.addEventListener('mouseenter', () => {
      box.querySelectorAll('.nt-sug-row').forEach(r => r.classList.remove('active'));
      el.classList.add('active');
    });
  });
}

// Keyboard nav on the search input — arrows move the highlight, Enter picks
// (synthetic mousedown so one handler serves mouse + keyboard), Escape just
// clears the suggestion list. Wired imperatively because the input is born
// inside a modal render (global-search does the same for its static input).
function wireCustomerSearch() {
  const input = document.getElementById('nt-cust-search');
  if (!input) return;
  input.focus();
  input.addEventListener('keydown', (e) => {
    const rows = [...document.querySelectorAll('.nt-sug-row')];
    if (!rows.length) return;
    const idx = rows.findIndex(r => r.classList.contains('active'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? (idx + 1) % rows.length : (idx - 1 + rows.length) % rows.length;
      rows.forEach(r => r.classList.remove('active'));
      rows[next].classList.add('active');
      rows[next].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      (rows[idx >= 0 ? idx : 0]).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    } else if (e.key === 'Escape') {
      const box = document.getElementById('nt-cust-sug');
      if (box) box.innerHTML = '';
      e.stopPropagation();
    }
  });
}

function pickCustomer(displayId) {
  const c = CUSTOMERS.find(x => x.id === displayId);
  if (!c) return;
  NT.customer = customerRef(c);
  const boxEl = document.getElementById('nt-cust-box');
  if (boxEl) boxEl.innerHTML = custBoxHtml();   // in-place swap — other fields keep their typed values
}

function clearCustomer() {
  NT.customer = null;
  const boxEl = document.getElementById('nt-cust-box');
  if (boxEl) { boxEl.innerHTML = custBoxHtml(); wireCustomerSearch(); }
}

// ─── Step 2 — drafting window ────────────────────────────────────────────────

function renderStep2() {
  const canDraft = !required('message');   // a required message forbids draft-only creation
  const tplOptions = TICKET_TEMPLATES.map(t => `<option value="${window.escAttr(t.id)}">${window.escHtml(t.name)}</option>`).join('');
  showModal('New Ticket — first message', `
    <div style="display:flex;gap:10px;align-items:center;padding:8px 12px;background:var(--off2);border:1px solid var(--rule);border-radius:var(--r);margin-bottom:12px;font-size:12px;color:var(--ink2);flex-wrap:wrap">
      <strong style="color:var(--ink)">${window.escHtml(NT.customer?.label || '—')}</strong>
      <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${window.escHtml(NT.customer?.displayId || '')}</span>
      <span>·</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px">${window.escHtml(NT.subject)}</span>
      ${NT.categoryLabel ? `<span>·</span><span>${window.escHtml(NT.categoryLabel)}</span>` : ''}
      ${NT.agentName !== '__auto__' ? `<span>·</span><span>→ ${window.escHtml(NT.agentName)}</span>` : ''}
      <span class="link" data-action="nt.back" style="margin-left:auto;font-size:11px">‹ Edit details</span>
    </div>
    ${TICKET_TEMPLATES.length ? `
    <div class="form-row">
      <label class="form-label">Insert template (appends)</label>
      <select class="form-input" id="nt2-template" data-change-action="nt.appendTemplate">
        <option value="">— Choose a template —</option>
        ${tplOptions}
      </select>
    </div>` : ''}
    <div class="form-row">
      <label class="form-label">Message to the customer${required('message') ? ' <span style="color:var(--red);font-weight:500" title="Required">*</span>' : ''}</label>
      <textarea class="form-input" id="nt2-msg" style="min-height:180px" placeholder="Write the first message…">${window.escHtml(NT.message)}</textarea>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
      ${canDraft ? `<button class="btn btn-sm" data-action="nt.saveDraft" id="nt2-draft-btn">Save as draft</button>
      <span style="font-size:11px;color:var(--ink3)">Creates the ticket and keeps the message as an unsent draft.</span>` : ''}
    </div>
  `, () => { void confirmSend(); }, 'Send', true);

  // A stray backdrop click must not destroy the drafted message — only ×,
  // Cancel, Send, or Save-as-draft leave this step.
  const bg = document.querySelector('#modal-container .modal-bg');
  if (bg) bg.dataset.action = '';
  // Retarget the footer Cancel to the explicit-discard action (resets NT).
  const cancelBtn = document.querySelector('#modal-container .modal-foot [data-action="modal.close"]');
  if (cancelBtn) cancelBtn.dataset.action = 'nt.cancel';
  document.getElementById('nt2-msg')?.focus();
}

function setStep2Busy(label) {
  NT.busy = true;
  const send = document.querySelector('#modal-container [data-action="modal.confirm"]');
  if (send) { send.disabled = true; send.textContent = label; }
  const draft = document.getElementById('nt2-draft-btn');
  if (draft) draft.disabled = true;
}

function step2Unbusy() {
  NT.busy = false;
  const send = document.querySelector('#modal-container [data-action="modal.confirm"]');
  if (send) { send.disabled = false; send.textContent = 'Send'; }
  const draft = document.getElementById('nt2-draft-btn');
  if (draft) draft.disabled = false;
}

async function confirmSend() {
  if (NT.busy) return;
  const msg = document.getElementById('nt2-msg')?.value.trim() || '';
  if (required('message') && !msg) { alert('First message is required.'); return; }
  setStep2Busy(msg ? 'Sending…' : 'Creating…');
  await finishCreate({ message: msg, send: !!msg });
}

async function saveAsDraft() {
  if (NT.busy) return;
  const msg = document.getElementById('nt2-msg')?.value.trim() || '';
  setStep2Busy('Creating…');
  await finishCreate({ message: msg, send: false });
}

// ─── Creation ────────────────────────────────────────────────────────────────

async function finishCreate({ message, send }) {
  const isApiBacked = Boolean(NT.customer?.uuid);
  let displayId;
  if (isApiBacked) {
    displayId = await createOnServer({ message, send });
    if (!displayId) { step2Unbusy(); return; }   // error already surfaced; modal stays open
  } else {
    displayId = createDemoTicket({ message, send });
  }
  setComposeTabValue('reply');   // drafts key off the live COMPOSE_TAB — land on the tab that shows it
  closeModal();
  resetNT();
  updateNavBadges();
  openTicket(displayId);         // lazy detail load paints the thread (incl. the sent message)
}

async function createOnServer({ message, send }) {
  const agentUserId = NT.agentName !== '__auto__' ? (AGENTS.find(a => a.name === NT.agentName)?.userId || null) : null;
  const body = { subject: NT.subject, customer_id: NT.customer.uuid, priority_key: NT.priority };
  if (NT.categoryValue) body.category_key = NT.categoryValue;
  if (agentUserId) body.assigned_user_id = agentUserId;

  let res;
  try { res = await apiPost('/api/v1/tickets', body); }
  catch (err) { showToast(`Couldn't create the ticket: ${err?.message || err}`, 'error', 6000); return null; }

  // Deploy-skew-proof local row: an older API echoes only {id, display_id},
  // so fall back to what the agent entered for every other column.
  const now = new Date().toISOString();
  const srv = res?.ticket || {};
  const row = {
    subject: NT.subject, status_key: 'open', priority_key: NT.priority,
    category_key: NT.categoryValue || null, assigned_user_id: agentUserId,
    customer_id: NT.customer.uuid, sla_state: 'ok', created_at: now, updated_at: now,
    snoozed_until: null, snoozed_at: null, snooze_reason: null, snooze_woken_at: null,
    merged_into_id: null, merged_at: null, status_before_merge: null,
    latest_customer_sentiment: null, last_message_role: null,
    ...srv,
  };
  updateOrInsertTicket(row);

  // Old-API fallback: the explicit assignee wasn't applied on create — the
  // existing membership-checked PATCH still lands it.
  if (agentUserId && row.assigned_user_id !== agentUserId) {
    try {
      await apiPatch(`/api/v1/tickets/${row.id}`, { assigned_user_id: agentUserId });
      const t = TICKETS.find(x => x._uuid === row.id);
      if (t) t.agent = NT.agentName;
    } catch { /* rules' pick stands; visible on the ticket */ }
  }

  if (send && message) {
    try {
      const mres = await apiPost(`/api/v1/tickets/${row.id}/messages`, { role: 'agent', body: message });
      notifyReplyDelivery(mres.delivery);
    } catch (err) {
      // The ticket already exists — retrying in the modal would duplicate it.
      // Rescue the text as a composer draft and let the agent send from there.
      saveDraftFor(row.display_id, 'reply', message);
      showToast('Ticket created, but the message failed to send — it was kept as a draft on the ticket.', 'warn', 8000);
    }
  } else if (message) {
    saveDraftFor(row.display_id, 'reply', message);
  }
  return row.display_id;
}

// Demo persona — the legacy in-memory mint, verbatim semantics.
function createDemoTicket({ message, send }) {
  // parseInt on non-numeric IDs returns NaN; filter them out so a stray
  // ticket like "TK-foo" can't poison Math.max into NaN.
  const ticketNums = TICKETS.map(t => parseInt((t.id || '').split('-')[1] || '0', 10)).filter(n => Number.isFinite(n));
  const newId = 'TK-' + String(Math.max(0, ...ticketNums) + 1).padStart(3, '0');
  TICKETS.unshift({
    id: newId, subject: NT.subject, customerId: NT.customer?.displayId || 'M001',
    status: 'open',
    priority: NT.priority,
    category: NT.categoryLabel || catOptions()[0]?.label || 'General',
    agent: NT.agentName === '__auto__' ? '' : NT.agentName,
    created: new Date().toISOString().slice(0, 10), updated: 'just now',
    sla: 'ok', tags: [], aiTags: [], csat: null,
    msgs: (send && message) ? [{ from: SESSION.name, r: 'agent', t: message, ts: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) }] : [],
  });
  if (NT.agentName === '__auto__') applyAssignmentRules(TICKETS[0]);
  refreshTicketSLA(TICKETS[0]);
  fireWebhook('ticket.created', ticketPayload(TICKETS[0]));
  if (!send && message) saveDraftFor(newId, 'reply', message);
  return newId;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

registerActions({
  'nt.clearCust': () => clearCustomer(),
  'nt.saveDraft': () => { void saveAsDraft(); },
  'nt.back':      () => {
    NT.message = document.getElementById('nt2-msg')?.value ?? NT.message;
    closeModal();
    renderStep1();
  },
  'nt.cancel':    () => { resetNT(); closeModal(); },
});

registerChangeActions({
  'nt.applyTemplate': (ds, el) => {
    // Template prefill overwrites subject/category/priority/message — same
    // semantics as the old single-step modal.
    applyTemplateToNT(el.value);
    const subj = document.getElementById('nt-subj');
    if (subj) subj.value = NT.subject;
    const cat = document.getElementById('nt-cat');
    if (cat) cat.value = NT.categoryValue;
    const pri = document.getElementById('nt-pri');
    if (pri) pri.value = NT.priority;
  },
  'nt.appendTemplate': (ds, el) => {
    const t = TICKET_TEMPLATES.find(x => x.id === el.value);
    el.value = '';
    if (!t?.body) return;
    const ta = document.getElementById('nt2-msg');
    if (ta) { ta.value = ta.value ? `${ta.value}\n\n${t.body}` : t.body; ta.focus(); }
  },
});

registerInputActions({
  'nt.custSearch': (ds, el) => renderSuggestions(el.value),
});

registerMousedownActions({
  'nt.pick': (ds) => pickCustomer(ds.custId),
});
