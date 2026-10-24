// ─── New Ticket flow (two-step) ──────────────────────────────────────────────
// Step 1 collects the compulsory details — customer (typeahead over the
// loaded CUSTOMERS array), category (KEYS as values), subject, priority,
// assignee. The agent confirms the conversation language before step 2,
// the drafting window: templates append, Send emails the
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
import { can } from '../core/permissions.js';
import { SESSION, CURRENT_TICKET, setComposeTabValue } from '../core/state.js';
import { updateNavBadges } from '../core/router.js';
import { showModal, closeModal } from '../core/modal.js';
import { registerActions, registerChangeActions, registerInputActions, registerMousedownActions } from '../core/event-delegation.js';
import { isFieldRequired, isFieldVisible } from '../layouts/index.js';
import { isAgentOOO, applyAssignmentRules } from './assignment-rules.js';
import { refreshTicketSLA } from './sla.js';
import { fireWebhook, ticketPayload } from '../webhooks/index.js';
import { apiPost, apiPatch, apiUpload, getJwt, getWorkspaceId } from '../core/api-client.js';
import { updateOrInsertTicket, loadTicketDetail } from '../core/bootstrap.js';
import { openTicket, notifyReplyDelivery, applySentStatus } from './detail.js';
import { matchesContact } from '../customers/contacts.js';
import { saveDraft, saveDraftAttachments, flushPersonalDraft, prepareDraftSend, finishDraftSend } from './drafts.js';
import { fmtBytes } from './attachment-chips.js';
import { showToast } from '../core/toast.js';
import { statusChoice, loadStatusOptions, statusOptionsState } from './status-options.js';
import { sendActions, SEND_ACTIONS, SEND_WITHOUT_AI_HINT } from './send-actions.js';
import { statusReasonField } from './status-reasons.js';
import { TRANSLATOR_LANGS, prepareCustomerReply, setCustomerLanguage } from '../ai/translate.js';
import { jurisdictionLanguage } from './jurisdiction-language.js';
import { showCloseTickets, applyClosedTicket } from './closure.js';
import { markCloseReminder } from './close-reminder.js';
import { filterTemplates, templateCategories } from './template-search.js';

// ─── Wizard state ────────────────────────────────────────────────────────────
// Survives the closeModal()+showModal() hop between steps; nothing here is
// persisted — the server (or the demo mint) only runs at the very end.
const NT = {
  statusReason: '',
  busy: false,
  templateId: null,
  customer: null,        // { uuid|null, displayId, label }
  categoryValue: '',     // category KEY (API-backed) or label (demo fallback)
  categoryLabel: '',
  subject: '',
  priority: 'normal',
  agentUserId: null,     // explicit assignee (user id) — null = Auto (rules)
  agentName: '',         // display name for the step-2 summary strip
  message: '',
  messageTouched: false, // the AGENT edited the message (vs a template filling it)
  replyLanguage: '',
  languageConfirmed: false,
  statusAfterSend: '',
  closeReason: '',
  files: [],
  createdTicket: null,
};

const templateFilters = { nt: { query: '', category: '' }, nt2: { query: '', category: '' } };

function resetNT() {
  for (const filter of Object.values(templateFilters)) { filter.query = ''; filter.category = ''; }
  NT.busy = false;
  NT.templateId = null;
  NT.customer = null;
  NT.categoryValue = '';
  NT.categoryLabel = '';
  NT.subject = '';
  NT.statusReason = '';
  NT.priority = 'normal';
  NT.agentUserId = null;
  NT.agentName = '';
  NT.message = '';
  NT.messageTouched = false;
  NT.replyLanguage = '';
  NT.languageConfirmed = false;
  NT.statusAfterSend = '';
  NT.closeReason = '';
  NT.files = [];
  NT.createdTicket = null;
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
  // Derived-from-seed-data fallback is DEMO ONLY: those values are labels,
  // and the API validates category_key against the workspace's real keys —
  // offering them in a real workspace would 400 the create. An API-backed
  // workspace with no active categories simply shows none (the category
  // guard then lets the create through uncategorised).
  if (isSessionApiBacked()) return [];
  return [...new Set([...TICKETS.map(t => t.category), ...TICKET_TEMPLATES.map(t => t.category)])]
    .filter(Boolean).map(l => ({ value: l, label: l }));
}

// Real workspace (persisted) vs demo persona (in-memory) — a property of the
// SESSION, never of which fields the layout happens to show.
function isSessionApiBacked() { return Boolean(getJwt() && getWorkspaceId()); }

// Templates store category as a FREE STRING — match it case-insensitively
// against both label and key; no match → '' (placeholder forces a pick).
function matchTemplateCategory(tplCategory) {
  if (!tplCategory) return null;
  const want = String(tplCategory).trim().toLowerCase();
  return catOptions().find(o => o.value.toLowerCase() === want || o.label.toLowerCase() === want) || null;
}

// ─── Entry point ─────────────────────────────────────────────────────────────
// templateId: prefill from a ticket template (ticket-templates page "Use").
// custDisplayId: prefill the customer (customer-profile "New ticket" button).
export async function showNewTicketModal(templateId, custDisplayId) {
  if (!can('tickets.create')) { showToast('Your role does not allow ticket creation.'); return; }
  const workspace = getWorkspaceId(), jwt = getJwt();
  if (workspace) await loadStatusOptions();
  if (workspace !== getWorkspaceId() || jwt !== getJwt()) return;
  if (!statusOptionsState().ready) { showToast('Reload ticket statuses before creating a ticket.'); return; }
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

// keepMessage: the agent may already have written the first message on step
// 2 — step 1 has no message field, so silently replacing it with a template
// body would destroy work with nothing on screen to show it. Callers pass
// NT.messageTouched (an explicit "the agent typed here" flag) rather than
// inferring from non-emptiness, which would also protect a body that only a
// PREVIOUS template put there.
function applyTemplateToNT(id, { keepMessage = false } = {}) {
  NT.templateId = id || null;
  const t = id ? TICKET_TEMPLATES.find(x => x.id === id) : null;
  if (!t) {
    NT.subject = '';
    if (!keepMessage) NT.message = '';
    NT.categoryValue = ''; NT.categoryLabel = '';
    return;
  }
  NT.subject = t.subject || '';
  if (!keepMessage) NT.message = t.body || '';
  if (t.priority) NT.priority = t.priority;
  const cat = matchTemplateCategory(t.category);
  NT.categoryValue = cat ? cat.value : '';
  NT.categoryLabel = cat ? cat.label : '';
}

// ─── Step 1 — details ────────────────────────────────────────────────────────

function templateOptions(prefix, selected = '') {
  const filter = templateFilters[prefix];
  const matches = filterTemplates(TICKET_TEMPLATES, filter.query, filter.category);
  const current = TICKET_TEMPLATES.find(t => t.id === selected);
  const option = t => `<option value="${window.escAttr(t.id)}" ${t.id === selected ? 'selected' : ''}>${window.escHtml(t.name)}</option>`;
  const retained = current && !matches.includes(current) ? `<optgroup label="Current selection (outside filters)">${option(current)}</optgroup>` : '';
  return {
    html: `<option value="" ${selected ? '' : 'selected'}>${prefix === 'nt' ? '— Blank ticket —' : '— Choose a template —'}</option>${retained}${matches.map(option).join('')}`,
    status: `${matches.length} of ${TICKET_TEMPLATES.length} templates.${matches.length ? '' : ' No templates match. Try another search or category.'}${retained ? ' Your current selection is kept.' : ''}`,
  };
}

function templateControls(prefix) {
  if (!TICKET_TEMPLATES.length) return '';
  const filter = templateFilters[prefix];
  const options = templateOptions(prefix, prefix === 'nt' ? NT.templateId : '');
  return `<div class="form-row nt-template-controls">
    <div class="template-filters">
      <label for="${prefix}-template-query">Search templates<input type="search" class="form-input" id="${prefix}-template-query" value="${window.escAttr(filter.query)}" placeholder="Name, subject, category, or message" data-input-action="nt.templateSearch" data-template-step="${prefix}" autocomplete="off"></label>
      <label for="${prefix}-template-category">Template category<select class="form-input" id="${prefix}-template-category" aria-label="Template category" data-change-action="nt.templateCategory" data-template-step="${prefix}">
        <option value="">All categories</option>
        ${templateCategories(TICKET_TEMPLATES).map(category => `<option value="${window.escAttr(category)}" ${category === filter.category ? 'selected' : ''}>${window.escHtml(category)}</option>`).join('')}
      </select></label>
    </div>
    <label class="form-label" for="${prefix}-template">${prefix === 'nt' ? 'Start from template (optional)' : 'Insert template (appends)'}</label>
    <select class="form-input" id="${prefix}-template" aria-describedby="${prefix}-template-count" data-change-action="${prefix === 'nt' ? 'nt.applyTemplate' : 'nt.appendTemplate'}">${options.html}</select>
    <p class="template-picker-hint" id="${prefix}-template-count" role="status">${window.escHtml(options.status)}</p>
  </div>`;
}

function filterTemplateOptions(prefix) {
  const select = document.getElementById(prefix + '-template');
  if (!select) return;
  const options = templateOptions(prefix, select.value);
  select.innerHTML = options.html;
  document.getElementById(prefix + '-template-count').textContent = options.status;
}

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
  // Deactivated members are excluded: the server refuses them (400 "not an
  // active member"), which would fail the create at the very last step.
  // Option VALUES are user ids, not names — names aren't unique (mapAgentRow
  // falls back to email, then 'Unknown'), and a name-based lookup miss would
  // silently drop the agent's deliberate pick.
  const agentRow = visible('agent')
    ? `<div class="form-row"><label class="form-label">Assign to${reqMark('agent')}</label>
        <select class="form-input" id="nt-agent">
          <option value="__auto__" ${NT.agentUserId ? '' : 'selected'}>Auto (apply rules)</option>
          ${AGENTS.filter(a => a.active !== false).map(a => `<option value="${window.escAttr(a.userId || a.name)}" ${NT.agentUserId === (a.userId || a.name) ? 'selected' : ''}>${window.escHtml(a.name)}${isAgentOOO(a.name) ? ' (OOO)' : ''}</option>`).join('')}
        </select>
      </div>`
    : '';

  showModal('New Ticket', `
    ${templateControls('nt')}
    ${customerRow}
    ${visible('subject') ? `<div class="form-row"><label class="form-label">Subject${reqMark('subject')}</label><input class="form-input" id="nt-subj" value="${window.escAttr(NT.subject)}" placeholder="Describe the issue…"/></div>` : ''}
    ${categoryRow || priorityRow ? `<div class="form-grid">${categoryRow}${priorityRow}</div>` : ''}
    ${agentRow}
    ${statusReasonField(statusChoice('open'), 'nt-status-reason', NT.statusReason)}
  `, () => {
    if (NT.busy) return;
    harvestStep1();
    if (!validateStep1(cats.length)) return;   // early-return keeps the modal open
    if (singleStep) {
      // No step 2 to host the busy state — guard the create here, or a
      // double-click on "Create ticket" mints two tickets.
      setBusy(true, 'Creating…');
      void finishCreate({ message: '', send: false });
      return;
    }
    closeModal();
    if (NT.languageConfirmed) renderStep2();
    else renderLanguageConfirmation();
  }, singleStep ? 'Create ticket' : 'Next — write the message');

  wireCustomerSearch();
}

function harvestStep1() {
  NT.statusReason = document.getElementById('nt-status-reason')?.value || '';
  NT.subject = document.getElementById('nt-subj')?.value.trim() ?? NT.subject;
  const catSel = document.getElementById('nt-cat');
  if (catSel) {
    NT.categoryValue = catSel.value || '';
    // Only a real pick carries a label — otherwise the placeholder's own text
    // ("Select a category…") would leak into the demo ticket's category.
    NT.categoryLabel = NT.categoryValue ? (catSel.selectedOptions[0]?.textContent || '') : '';
  }
  NT.priority = document.getElementById('nt-pri')?.value || NT.priority;
  const agentSel = document.getElementById('nt-agent');
  if (agentSel) {
    const v = agentSel.value;
    NT.agentUserId = (!v || v === '__auto__') ? null : v;
    NT.agentName = NT.agentUserId ? (agentSel.selectedOptions[0]?.textContent.replace(/ \(OOO\)$/, '') || '') : '';
  }
}

function validateStep1(haveCats) {
  if (statusChoice('open')?.reason_required && !NT.statusReason) { alert('Choose a reason for the Open status.'); document.getElementById('nt-status-reason')?.focus(); return false; }
  if (visible('customerId') && !NT.customer) { alert('Pick a customer — search by name, email, or ID.'); return false; }
  if (visible('subject') && required('subject') && !NT.subject) { alert('Subject is required.'); return false; }
  // Category is compulsory (locked required in FIELD_LAYOUTS) — agents must
  // actively pick an accurate one. A workspace with no categories at all has
  // nothing to pick, so don't dead-end it.
  if (visible('category') && haveCats && !NT.categoryValue) { alert('Please select a category.'); return false; }
  if (visible('priority') && required('priority') && !NT.priority) { alert('Priority is required.'); return false; }
  if (visible('agent') && required('agent') && !NT.agentUserId) {
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
    matchesContact(c, needle) ||
    (c.username || '').toLowerCase().includes(needle)
  )).slice(0, 8);
}

function renderSuggestions(q) {
  const box = document.getElementById('nt-cust-sug');
  if (!box) return;
  const rows = matchCustomers(q);
  if (!rows.length) { box.innerHTML = ''; return; }
  // Reuses the global-search dropdown classes (.gs-results/.gs-result in
  // web/styles/shell.css) so the keyboard highlight is actually VISIBLE and
  // hover comes from CSS — no inline styles, no per-row listeners.
  box.innerHTML = `
    <div class="gs-results show" style="top:2px">
      ${rows.map((c, i) => `
        <div class="gs-result ${i === 0 ? 'active' : ''}" data-mousedown-action="nt.pick" data-cust-id="${window.escAttr(c.id)}">
          <span class="gs-result-type">${window.escHtml(c.id)}</span>
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(`${c.first} ${c.last}`.trim() || c.id)}${c.email ? ` · ${window.escHtml(c.email)}` : ''}</span>
        </div>`).join('')}
    </div>`;
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
    const rows = [...document.querySelectorAll('#nt-cust-sug .gs-result')];
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
  if (NT.customer?.displayId !== displayId) {
    NT.replyLanguage = '';
    NT.languageConfirmed = false;
  }
  NT.customer = customerRef(c);
  const boxEl = document.getElementById('nt-cust-box');
  if (boxEl) boxEl.innerHTML = custBoxHtml();   // in-place swap — other fields keep their typed values
}

function clearCustomer() {
  NT.customer = null;
  NT.replyLanguage = '';
  NT.languageConfirmed = false;
  const boxEl = document.getElementById('nt-cust-box');
  if (boxEl) { boxEl.innerHTML = custBoxHtml(); wireCustomerSearch(); }
}

// ─── Step 2 — drafting window ────────────────────────────────────────────────

function renderLanguageConfirmation() {
  const customer = CUSTOMERS.find(c => c.id === NT.customer?.displayId);
  const jurisdiction = String(customer?.jurisdiction || '').trim();
  const saved = TRANSLATOR_LANGS.includes(customer?.preferredLanguage) ? customer.preferredLanguage : '';
  const suggested = saved || jurisdictionLanguage(jurisdiction);
  showModal('Confirm conversation language', `
    <p>${saved
      ? `Saved preferred language: <strong>${window.escHtml(saved)}</strong>.`
      : suggested
      ? `Suggested language: <strong>${window.escHtml(suggested)}</strong>, based on the customer's jurisdiction: <strong>${window.escHtml(jurisdiction)}</strong>.`
      : `Choose a language for this conversation. ${jurisdiction ? `Jurisdiction: <strong>${window.escHtml(jurisdiction)}</strong>.` : 'No jurisdiction is saved for this customer.'}`}</p>
    <p id="nt-language-help">${suggested ? 'Confirm the suggestion or choose another language' : 'Choose a language'} before writing the first message. Your confirmed choice is saved on the customer profile for future conversations.</p>
    <div class="form-row">
      <label class="form-label" for="nt-language">Conversation language</label>
      <select class="form-input" id="nt-language" data-change-action="nt.languageChoice" aria-describedby="nt-language-help nt-language-error" required>
        <option value="" ${suggested ? '' : 'selected'} disabled>Choose a language…</option>
        ${TRANSLATOR_LANGS.map(lang => `<option ${suggested === lang ? 'selected' : ''}>${lang}</option>`).join('')}
      </select>
      <p id="nt-language-error" role="alert" hidden>Choose a language to continue.</p>
    </div>
  `, async () => {
    if (NT.busy) return;
    const select = document.getElementById('nt-language');
    if (!TRANSLATOR_LANGS.includes(select?.value)) {
      document.getElementById('nt-language-error').hidden = false;
      select?.setAttribute('aria-invalid', 'true');
      select?.focus();
      return;
    }
    const language = select.value;
    const workspace = getWorkspaceId(), jwt = getJwt();
    const modal = select.closest('.modal');
    setBusy(true, 'Saving language…');
    let saveError;
    try {
      if (isSessionApiBacked()) {
        if (!customer?._uuid) throw new Error('Choose a saved customer before continuing.');
        const res = await apiPatch(`/api/v1/customers/${customer._uuid}`, { preferred_language: language });
        if (res?.customer?.preferred_language !== language) throw new Error('The language could not be confirmed as saved. Please try again.');
      }
    } catch (err) {
      saveError = err;
    }
    if (!modal.isConnected) return;
    if (workspace !== getWorkspaceId() || jwt !== getJwt()) {
      closeModal(); resetNT();
      showToast('Your workspace or session changed. Reopen the ticket form to continue.');
      return;
    }
    setBusy(false);
    if (saveError) {
      const error = document.getElementById('nt-language-error');
      error.textContent = `Could not save the preferred language. ${saveError?.message || 'Try again.'}`;
      error.hidden = false;
      select.focus();
      return;
    }
    if (customer) customer.preferredLanguage = language;
    NT.replyLanguage = language;
    NT.languageConfirmed = true;
    closeModal();
    renderStep2();
  }, 'Confirm and continue');
  const modal = document.querySelector('#modal-container .modal');
  modal.classList.add('conversation-language-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Confirm conversation language');
  modal.querySelector('.modal-close').outerHTML = '<button type="button" class="modal-close" data-action="nt.cancel" aria-label="Cancel new conversation">×</button>';
  const back = modal.querySelector('.modal-foot [data-action="modal.close"]');
  back.textContent = 'Back';
  back.dataset.action = 'nt.languageBack';
  modal.addEventListener('keydown', event => {
    if (NT.busy) { event.preventDefault(); return; }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal();
      renderStep1();
      document.querySelector('#modal-container [data-action="modal.confirm"]')?.focus();
    } else if (event.key === 'Tab') {
      const controls = [...modal.querySelectorAll('button, select')];
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  document.getElementById('nt-language')?.focus();
}

function renderNewTicketFiles() {
  if (!isSessionApiBacked() || !can('tickets.attach') || !can('tickets.reply')) return '';
  return `<div class="form-row">
    <label class="form-label" for="nt2-files">Attachments (${NT.files.length ? `${NT.files.length} selected` : 'optional'})</label>
    <input class="form-input" type="file" id="nt2-files" multiple data-change-action="nt.files" aria-describedby="nt2-files-hint" style="min-height:44px">
    <p id="nt2-files-hint" style="font-size:12px;color:var(--ink3)">Up to 20 files, 10 MB each. Sending allows 7 MB total. Files upload when you send or save as draft.</p>
    <ul style="list-style:none;padding:0;margin:0">${NT.files.map((entry, index) => `<li style="display:flex;align-items:center;gap:8px;overflow-wrap:anywhere">
      <span style="flex:1;min-width:0">${window.escHtml(entry.file.name)} <span style="color:var(--ink3)">${fmtBytes(entry.file.size)}${entry.attachment ? ' · Uploaded' : ''}</span></span>
      <button type="button" class="btn btn-sm" style="min-width:44px;min-height:44px" data-action="nt.removeFile" data-index="${index}" aria-label="Remove ${window.escAttr(entry.file.name)}">Remove</button>
    </li>`).join('')}</ul>
  </div>`;
}

function renderStep2() {
  const canDraft = !required('message');
  const actions = sendActions();
  const action = actions.find(a => a.status === NT.statusAfterSend) || SEND_ACTIONS[0];
  showModal('New Ticket — first message', `
    <div style="display:flex;gap:10px;align-items:center;padding:8px 12px;background:var(--off2);border:1px solid var(--rule);border-radius:var(--r);margin-bottom:12px;font-size:12px;color:var(--ink2);flex-wrap:wrap">
      <strong style="color:var(--ink)">${window.escHtml(NT.customer?.label || '—')}</strong>
      <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${window.escHtml(NT.customer?.displayId || '')}</span>
      <span>·</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px">${window.escHtml(NT.subject)}</span>
      ${NT.categoryLabel ? `<span>·</span><span>${window.escHtml(NT.categoryLabel)}</span>` : ''}
      ${NT.agentUserId ? `<span>·</span><span>→ ${window.escHtml(NT.agentName)}</span>` : ''}
      ${NT.createdTicket ? '' : '<span class="link" data-action="nt.back" style="margin-left:auto;font-size:11px">‹ Edit details</span>'}
    </div>
    ${NT.createdTicket ? `<p role="status">Ticket ${window.escHtml(NT.createdTicket.row.display_id)} is already created. Retry the remaining uploads here, or cancel to open its draft. No message has been sent.</p>` : templateControls('nt2')}
    <div class="form-row">
      <label class="form-label" for="nt2-msg">Message to the customer${required('message') ? ' <span style="color:var(--red);font-weight:500" title="Required">*</span>' : ''}</label>
      <textarea class="form-input" id="nt2-msg" data-input-action="nt.msgInput" style="min-height:180px" placeholder="Write the first message…">${window.escHtml(NT.message)}</textarea>
    </div>
    ${renderNewTicketFiles()}
    <div class="form-row">
      <label class="form-label" for="nt2-language">Reply language</label>
      <select class="form-input" id="nt2-language" data-change-action="nt.replyLanguage">
        <option value="">As written</option>
        ${TRANSLATOR_LANGS.map(lang => `<option ${NT.replyLanguage === lang ? 'selected' : ''}>${lang}</option>`).join('')}
      </select>
    </div>
    <div style="margin-top:4px">
      <button class="btn btn-sm" data-action="nt.sendWithoutAI" id="nt2-without-ai-btn" aria-describedby="nt2-without-ai-hint" ${NT.statusAfterSend ? 'disabled title="Choose Send to send without AI."' : ''}>Send without AI…</button>
      <p id="nt2-without-ai-hint" style="font-size:12px;color:var(--ink3);line-height:1.5;margin:6px 0 12px">${window.escHtml(SEND_WITHOUT_AI_HINT)}</p>
      ${canDraft ? `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><button class="btn btn-sm" data-action="nt.saveDraft" id="nt2-draft-btn">Save as draft</button>
      <span style="font-size:11px;color:var(--ink3)">Creates the ticket and keeps the message as an unsent draft.</span></div>` : ''}
    </div>
    <div class="form-row" style="margin-top:16px">
      <label class="form-label" for="nt2-after-send">Send action</label>
      <select class="form-input" id="nt2-after-send" aria-describedby="nt2-action-hint" data-change-action="nt.afterSend">
        ${actions.map(a => `<option value="${window.escAttr(a.status)}" ${a.status === NT.statusAfterSend ? 'selected' : ''}>${window.escHtml(a.label)}</option>`).join('')}
      </select>
    </div>
    <p id="nt2-action-hint">${NT.statusAfterSend ? window.escHtml(action.hint) : 'Leaves the new ticket open. No survey.'} Status changes happen only after the email is sent.</p>
    ${NT.statusAfterSend ? `<p>Your first message uses the normal AI and translation checks.</p>
      ${statusReasonField(statusChoice(NT.statusAfterSend), 'nt2-close-reason', NT.closeReason)}
      ${NT.statusAfterSend === 'closed' && statusChoice('closed')?.reasons?.some(r => r.key === 'spam' && r.is_active) ? '<p>Choosing Spam also marks the customer as spam and closes future emails from their addresses in this workspace.</p>' : ''}` : ''}
  `, () => { void confirmSend(); }, action.label, true);

  // A stray backdrop click must not destroy the drafted message — only ×,
  // Cancel, Send, or Save-as-draft leave this step.
  const bg = document.querySelector('#modal-container .modal-bg');
  if (bg) bg.dataset.action = '';
  // Retarget the footer Cancel to the explicit-discard action (resets NT).
  const cancelBtn = document.querySelector('#modal-container .modal-foot [data-action="modal.close"]');
  if (cancelBtn) cancelBtn.dataset.action = 'nt.cancel';
  const close = document.querySelector('#modal-container .modal-close');
  if (close) close.outerHTML = '<button type="button" class="modal-close" data-action="nt.cancel" aria-label="Cancel new ticket" style="border:0;background:transparent;min-width:44px;min-height:44px">×</button>';
  document.getElementById('nt2-msg')?.focus();
}

// Freeze / unfreeze whichever step is on screen while a create is in flight.
// EVERY exit is disabled, not just the confirm: nt.cancel's resetNT() would
// otherwise null NT.customer mid-await and blow up the post-await read.
// `busyLabel` remembers the confirm's original text so unbusy can restore it
// (step 1 says "Create ticket", step 2 "Send").
let _confirmLabelBeforeBusy = '';

function setBusy(on, label) {
  NT.busy = on;
  document.querySelectorAll('#modal-container input, #modal-container textarea, #modal-container select')
    .forEach(el => { el.disabled = on; });
  const confirm = document.querySelector('#modal-container [data-action="modal.confirm"]');
  if (confirm) {
    if (on) { _confirmLabelBeforeBusy = confirm.textContent; confirm.textContent = label; }
    else if (_confirmLabelBeforeBusy) { confirm.textContent = _confirmLabelBeforeBusy; }
    confirm.disabled = on;
  }
  const draft = document.getElementById('nt2-draft-btn');
  if (draft) draft.disabled = on;
  const manualSend = document.getElementById('nt2-without-ai-btn');
  if (manualSend) manualSend.disabled = on || NT.statusAfterSend;
  document.querySelectorAll('#modal-container [data-action="nt.removeFile"]').forEach(el => { el.disabled = on; });
  document.querySelectorAll('#modal-container [data-action="nt.cancel"], #modal-container [data-action="modal.close"], #modal-container [data-action="nt.back"], #modal-container [data-action="nt.languageBack"]')
    .forEach(el => {
      if (el.tagName === 'BUTTON') el.disabled = on;
      el.style.pointerEvents = on ? 'none' : '';
      el.style.opacity = on ? '.5' : '';
    });
}

async function confirmSend(withoutAI = false) {
  if (NT.busy) return;
  if (withoutAI && NT.statusAfterSend) return;
  const msg = document.getElementById('nt2-msg')?.value.trim() || '';
  NT.message = msg;
  if (NT.files.length && !msg) { alert('Write a message to send attachments, or choose Save as draft.'); return; }
  if (NT.files.reduce((size, entry) => size + entry.file.size, 0) > 7 * 1024 * 1024) { alert('Attachments are too large to email (max 7 MB in total). Remove some files or save as draft.'); return; }
  if ((required('message') || NT.statusAfterSend) && !msg) { alert('First message is required.'); return; }
  if (withoutAI && msg && !window.confirm('Send without AI?\n\nYour message and subject will not be translated. The header, signature and footer will use their saved wording. Check that the customer can understand them.')) return;
  setBusy(true, msg ? 'Sending…' : 'Creating…');
  if (NT.statusAfterSend) {
    if (!can('tickets.edit') || !can('tickets.close')) { setBusy(false); showToast('Your role does not allow changing ticket status.', 'error'); return; }
    const workspace = getWorkspaceId(), jwt = getJwt(), form = document.getElementById('nt2-msg');
    await loadStatusOptions(true);
    if (form?.isConnected === false) return;
    if (workspace !== getWorkspaceId() || jwt !== getJwt()) { closeModal(); resetNT(); return; }
    setBusy(false);
    const choice = statusChoice(NT.statusAfterSend);
    if (!statusOptionsState().ready || !choice?.is_active) { showToast('This status is unavailable. Refresh the status options before sending.'); return; }
    const reason = document.getElementById('nt2-close-reason')?.value || '';
    if ((choice.reason_required || reason) && !choice.reasons.some(r => r.key === reason && r.is_active)) {
      alert('Choose a status reason.'); document.getElementById('nt2-close-reason')?.focus(); return;
    }
    NT.closeReason = reason;
    setBusy(true, 'Sending…');
  }
  await finishCreate({ message: msg, send: !!msg, withoutAI, statusAfterSend: NT.statusAfterSend, closeReason: NT.closeReason });
}

async function saveAsDraft() {
  if (NT.busy) return;
  const msg = document.getElementById('nt2-msg')?.value.trim() || '';
  NT.message = msg;
  setBusy(true, 'Creating…');
  await finishCreate({ message: msg, send: false });
}

// ─── Creation ────────────────────────────────────────────────────────────────

// Single funnel for every create trigger. An unexpected throw anywhere in
// the path must not leave the modal frozen (NT.busy true, every button
// disabled) with no way forward — surface it and unfreeze.
async function finishCreate(args) {
  try {
    await runCreate(args);
  } catch (err) {
    console.error('[new-ticket] create failed:');
    showToast(`Couldn't finish creating the ticket: ${err?.message || err}`, 'error', 8000);
    setBusy(false);
  }
}

async function runCreate({ message, send, withoutAI = false, statusAfterSend = '', closeReason = '' }) {
  // Which path applies is a property of the SESSION, not of the pick: a real
  // workspace whose layout HIDES the Customer field leaves NT.customer null,
  // and routing that to the demo mint would silently create a ghost ticket
  // that vanishes on reload — the exact bug this phase exists to kill. Demo
  // personas carry no JWT/workspace, so they still take the in-memory path.
  const isApiBacked = isSessionApiBacked();
  const workspace = getWorkspaceId(), jwt = getJwt();
  const form = document.getElementById('nt2-msg') || document.getElementById('nt-subj');
  // Snapshot everything the async path needs BEFORE the first await — NT is
  // module state and must not be read across it.
  const snapshot = {
    customerUuid: NT.customer?.uuid || null,
    customerDisplayId: NT.customer?.displayId || 'M001',
    subject: NT.subject,
    statusReason: NT.statusReason,
    categoryValue: NT.categoryValue,
    categoryLabel: NT.categoryLabel,
    priority: NT.priority,
    agentUserId: NT.agentUserId,
    agentName: NT.agentName,
    replyLanguage: withoutAI ? '' : NT.replyLanguage,
    files: [...NT.files],
  };
  let displayId, keptDraft = false, emailed = false;
  if (isApiBacked) {
    if (send && message && !withoutAI) {
      const prepared = await prepareCustomerReply({ autoTranslateReplies: !!snapshot.replyLanguage,
        customerLanguageManual: !!snapshot.replyLanguage, detectedCustomerLang: snapshot.replyLanguage || null }, message, null);
      if (!prepared.replyLanguage) throw new Error('Choose a reply language before sending. Your draft has been kept.');
      if (workspace !== getWorkspaceId() || jwt !== getJwt()) throw new Error('Your workspace or session changed. Reopen the ticket form before sending.');
      message = prepared.translation;
      snapshot.replyLanguage = prepared.replyLanguage;
    }
    if (form?.isConnected === false) return;
    const res = await createOnServer(snapshot, { message, send });
    if (form?.isConnected === false) return;
    if (workspace !== getWorkspaceId() || jwt !== getJwt()) { closeModal(); resetNT(); return; }
    // Upload retries retain the created ticket; other failures open its draft.
    if (!res) { setBusy(false); return; }
    if (res.retry) { setBusy(false); renderStep2(); return; }
    if (res.aborted) {
      setBusy(false); closeModal(); resetNT();
      if (res.unsentMessage) showModal('Ticket created — first message not sent', `
        <p>The ticket was created, but its ID could not be confirmed. Reload the ticket list to find it before continuing. Do not create another ticket.</p>
        <label class="form-label" for="nt-recovery-message">Unsent first message — copy before closing</label>
        <textarea class="form-input" id="nt-recovery-message" readonly rows="6">${window.escHtml(res.unsentMessage)}</textarea>
      `, () => closeModal(), 'Close');
      return;
    }
    displayId = res.displayId; keptDraft = res.keptDraft; emailed = res.emailed === true;
  } else {
    const res = createDemoTicket(snapshot, { message, send });
    displayId = res.displayId; keptDraft = res.keptDraft;
    emailed = send && !!message;
  }
  // Only move the app-wide compose tab when there IS a reply draft to reveal
  // — silently switching an agent out of Internal-note mode otherwise.
  if (keptDraft) setComposeTabValue('reply');
  closeModal();
  resetNT();
  updateNavBadges();
  openTicket(displayId);         // lazy detail load paints the thread (incl. the sent message)
  if (statusAfterSend && emailed) {
    if (statusAfterSend === 'closed') await closeCreatedTicket(displayId, closeReason, workspace, jwt);
    else await applySentStatus(displayId, statusAfterSend, closeReason || null);
  }
  else if (statusAfterSend) showToast('Ticket created and left open because the first email was not confirmed sent. Continue from this ticket; do not create it again.', 'warn', 10000);
}

async function closeCreatedTicket(id, reason, workspace, jwt) {
  const ticket = TICKETS.find(t => t.id === id);
  if (!ticket) return;
  await markCloseReminder(ticket);
  if (workspace !== getWorkspaceId() || jwt !== getJwt()) return;
  const current = () => workspace === getWorkspaceId() && jwt === getJwt() && CURRENT_TICKET === id;
  try {
    const result = ticket._uuid ? await apiPost(`/api/v1/tickets/${ticket._uuid}/close`, { reason: reason || null, status_option_key: 'closed' }) : null;
    if (workspace !== getWorkspaceId() || jwt !== getJwt()) return;
    applyClosedTicket(ticket, result, reason);
    if (current()) { updateNavBadges(); openTicket(id); }
  } catch (err) {
    if (!current()) return;
    showCloseTickets([id], async succeeded => {
      if (!succeeded.length || !current()) return;
      await loadTicketDetail(id, { force: true });
      if (current()) { updateNavBadges(); openTicket(id); }
    }, reason);
    const error = document.getElementById('closure-error');
    if (error) {
      error.textContent = `The first email was sent. Retry closing only; the ticket and message will not be created again. ${err?.message || 'Could not close the ticket.'}`;
      error.closest('.modal').querySelector('[data-action="modal.confirm"]').textContent = 'Retry close only';
    }
  }
}

async function createOnServer(snap, { message, send }) {
  const workspace = getWorkspaceId(), jwt = getJwt();
  const form = document.getElementById('nt2-msg') || document.getElementById('nt-subj');
  const current = () => workspace === getWorkspaceId() && jwt === getJwt() && form?.isConnected !== false;
  if (snap.files?.length && (!can('tickets.attach') || !can('tickets.reply'))) {
    showToast('Your role does not allow reply attachments.', 'error'); return null;
  }
  if (NT.createdTicket && (workspace !== NT.createdTicket.workspace || jwt !== NT.createdTicket.jwt)) return { aborted: true };
  // The API requires a customer. The only way to reach this without one is a
  // workspace whose layout hides the Customer field — say so plainly instead
  // of failing with a schema error.
  if (!snap.customerUuid) {
    showToast('This workspace hides the Customer field, but a ticket needs one — re-enable it under Configuration › Layouts.', 'error', 8000);
    return null;
  }
  const body = { subject: snap.subject, customer_id: snap.customerUuid, priority_key: snap.priority, status_reason: snap.statusReason || null };
  if (snap.categoryValue) body.category_key = snap.categoryValue;
  if (snap.agentUserId) body.assigned_user_id = snap.agentUserId;

  let res;
  try { res = NT.createdTicket ? { ticket: NT.createdTicket.row } : await apiPost('/api/v1/tickets', body); }
  catch (err) { showToast(`Couldn't create the ticket: ${err?.message || err}`, 'error', 6000); return null; }
  if (!current()) return { aborted: true };

  // Deploy-skew-proof local row: an older API echoes only {id, display_id},
  // so fall back to what the agent entered for every other column.
  const now = new Date().toISOString();
  const srv = res?.ticket || {};
  if (!srv.id || !srv.display_id) {
    // The POST succeeded, so a ticket EXISTS — we just can't address it.
    // Close everything (aborted) rather than inviting a retry that would
    // create a second one; the message text is surfaced for copy/paste.
    showToast(
      message
        ? "The ticket was created but the server's response was incomplete — reload to find it, then send your message from the ticket."
        : "The ticket was created but the server's response was incomplete — reload to see it.",
      'warn', 10000,
    );
    return { aborted: true, unsentMessage: message };
  }
  const row = {
    subject: snap.subject, status_key: 'open', priority_key: snap.priority,
    category_key: snap.categoryValue || null, assigned_user_id: snap.agentUserId,
    customer_id: snap.customerUuid, sla_state: 'ok', created_at: now, updated_at: now,
    snoozed_until: null, snoozed_at: null, snooze_reason: null, snooze_woken_at: null,
    merged_into_id: null, merged_at: null, status_before_merge: null,
    latest_customer_sentiment: null, last_message_role: null,
    ...srv,
  };
  if (snap.files?.length) NT.createdTicket = { row, workspace, jwt };
  updateOrInsertTicket(row);
  if (snap.replyLanguage) setCustomerLanguage(row.display_id, snap.replyLanguage);

  // Old-API fallback: the explicit assignee wasn't applied on create — the
  // existing membership-checked PATCH still lands it.
  if (snap.agentUserId && row.assigned_user_id !== snap.agentUserId) {
    try {
      await apiPatch(`/api/v1/tickets/${row.id}`, { assigned_user_id: snap.agentUserId });
      const t = TICKETS.find(x => x._uuid === row.id);
      if (t) t.agent = snap.agentName;
    } catch { /* rules' pick stands; visible on the ticket */ }
  }
  if (!current()) return { aborted: true };

  if (snap.files?.length || NT.createdTicket) return createWithFiles(row, snap, { message, send }, current);

  let keptDraft = false, emailed = false;
  if (send && message) {
    let mres;
    try {
      // ONLY the network call is in the try — a throw from the toast helper
      // below would otherwise be misreported as a send failure and prompt a
      // duplicate send.
      mres = await apiPost(`/api/v1/tickets/${row.id}/messages`, { role: 'agent', body: message, reply_language: snap.replyLanguage || undefined });
    } catch (err) {
      if (!current()) return { aborted: true };
      // The ticket already exists — retrying in the modal would duplicate it.
      // Rescue the text as a composer draft and let the agent send from there.
      saveDraft(row.display_id, message, 'reply');
      showToast('Ticket created, but the message failed to send — it was kept as a draft on the ticket.', 'warn', 8000);
      return { displayId: row.display_id, keptDraft: true };
    }
    if (!current()) return { aborted: true };
    emailed = mres?.delivery?.emailed === true;
    if (mres?.delivery) notifyReplyDelivery(mres.delivery);
    if (mres?.subject) {
      const ticket = TICKETS.find(t => t._uuid === row.id);
      if (ticket) ticket.subject = mres.subject;
    }
  } else if (message) {
    saveDraft(row.display_id, message, 'reply');
    keptDraft = true;
  }
  return { displayId: row.display_id, keptDraft, emailed };
}

async function createWithFiles(row, snap, { message, send }, current) {
  try {
    saveDraft(row.display_id, message, 'reply');
    saveDraftAttachments(row.display_id, snap.files.filter(entry => entry.attachment).map(entry => entry.attachment));
    await flushPersonalDraft(row.display_id, 'reply');
    for (const entry of snap.files) {
      if (!current()) return { aborted: true };
      if (entry.attachment) continue;
      setBusy(true, `Attaching ${entry.file.name}…`);
      const form = new FormData(); form.append('file', entry.file, entry.file.name);
      const response = await apiUpload(`/api/v1/tickets/${row.id}/attachments`, form);
      if (!current()) return { aborted: true };
      if (!response?.attachment?.id) throw new Error('The upload could not be confirmed. Retry this file.');
      entry.attachment = response.attachment;
      saveDraftAttachments(row.display_id, snap.files.filter(file => file.attachment).map(file => file.attachment));
      await flushPersonalDraft(row.display_id, 'reply');
    }
  } catch (error) {
    if (!current()) return { aborted: true };
    showToast(`Ticket ${row.display_id} is saved, but its attachments are not ready. No message was sent. Retry here. ${error.message}`, 'warn', 10000);
    return { retry: true };
  }
  if (!current()) return { aborted: true };
  if (!send) return { displayId: row.display_id, keptDraft: true };
  let sent;
  try { sent = await prepareDraftSend(row.display_id, 'reply'); }
  catch (error) { showToast(error.message, 'error'); return { retry: true }; }
  if (!current()) { finishDraftSend(row.display_id, 'reply', sent); return { aborted: true }; }
  let response;
  try {
    response = await apiPost(`/api/v1/tickets/${row.id}/messages`, { role: 'agent', body: message,
      reply_language: snap.replyLanguage || undefined, draft_version: sent.version,
      attachment_ids: snap.files.map(entry => entry.attachment.id) });
  } catch {
    try { finishDraftSend(row.display_id, 'reply', sent); } catch { /* Continue on the existing ticket, never resend from the wizard. */ }
    if (!current()) return { aborted: true };
    showToast('Ticket created, but sending could not be confirmed. Check the ticket before retrying. Your draft has been kept.', 'warn', 10000);
    return { displayId: row.display_id, keptDraft: true };
  }
  try { finishDraftSend(row.display_id, 'reply', sent, response.draft_version); }
  catch { showToast('Message saved. The local draft cache could not be updated. Reopen the ticket before continuing.', 'error'); }
  if (!current()) return { aborted: true };
  if (response.delivery) notifyReplyDelivery(response.delivery);
  if (response.subject) {
    const ticket = TICKETS.find(t => t._uuid === row.id);
    if (ticket) ticket.subject = response.subject;
  }
  return { displayId: row.display_id, keptDraft: false, emailed: response.delivery?.emailed === true };
}

// Demo persona — the legacy in-memory mint, verbatim semantics.
function createDemoTicket(snap, { message, send }) {
  // parseInt on non-numeric IDs returns NaN; filter them out so a stray
  // ticket like "TK-foo" can't poison Math.max into NaN.
  const ticketNums = TICKETS.map(t => parseInt((t.id || '').split('-')[1] || '0', 10)).filter(n => Number.isFinite(n));
  const newId = 'TK-' + String(Math.max(0, ...ticketNums) + 1).padStart(3, '0');
  TICKETS.unshift({
    id: newId, subject: snap.subject, customerId: snap.customerDisplayId,
    status: 'open',
    priority: snap.priority,
    category: snap.categoryLabel || catOptions()[0]?.label || 'General',
    agent: snap.agentName || '',
    created: new Date().toISOString().slice(0, 10), _createdAt: new Date().toISOString(), updated: 'just now', _listUpdatedAt: new Date().toISOString(),
    sla: 'ok', tags: [], aiTags: [], csat: null,
    msgs: (send && message) ? [{ from: SESSION.name, r: 'agent', t: message, ts: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) }] : [],
  });
  if (!snap.agentUserId) applyAssignmentRules(TICKETS[0]);
  refreshTicketSLA(TICKETS[0]);
  fireWebhook('ticket.created', ticketPayload(TICKETS[0]));
  const keptDraft = Boolean(!send && message);
  if (keptDraft) saveDraft(newId, message, 'reply');
  return { displayId: newId, keptDraft };
}

// ─── Actions ─────────────────────────────────────────────────────────────────

registerActions({
  'nt.languageBack': () => {
    if (NT.busy) return;
    closeModal(); renderStep1();
    document.querySelector('#modal-container [data-action="modal.confirm"]')?.focus();
  },
  'nt.clearCust': () => clearCustomer(),
  'nt.sendWithoutAI': () => { void confirmSend(true); },
  'nt.saveDraft': () => { void saveAsDraft(); },
  'nt.back':      () => {
    if (NT.busy || NT.createdTicket) return;
    const ta = document.getElementById('nt2-msg');
    if (ta) { NT.message = ta.value; if (ta.value.trim()) NT.messageTouched = true; }
    NT.closeReason = document.getElementById('nt2-close-reason')?.value ?? NT.closeReason;
    closeModal();
    renderStep1();
  },
  'nt.removeFile': ds => {
    if (NT.busy) return;
    NT.message = document.getElementById('nt2-msg')?.value || '';
    NT.closeReason = document.getElementById('nt2-close-reason')?.value ?? NT.closeReason;
    NT.files.splice(Number(ds.index), 1);
    if (NT.createdTicket) saveDraftAttachments(NT.createdTicket.row.display_id, NT.files.filter(entry => entry.attachment).map(entry => entry.attachment));
    renderStep2();
    document.getElementById('nt2-files')?.focus();
  },
  'nt.cancel':    () => {
    if (NT.busy) return;
    const created = NT.createdTicket;
    if (created && NT.files.some(entry => !entry.attachment) && !window.confirm('Open the saved ticket draft? Files that have not uploaded will need to be selected again.')) return;
    if (created && created.workspace === getWorkspaceId() && created.jwt === getJwt()) {
      saveDraft(created.row.display_id, document.getElementById('nt2-msg')?.value || NT.message, 'reply');
      setComposeTabValue('reply'); openTicket(created.row.display_id);
    }
    resetNT(); closeModal();
  },
});

registerChangeActions({
  'nt.files': (ds, input) => {
    if (NT.busy || !can('tickets.attach') || !can('tickets.reply')) return;
    NT.message = document.getElementById('nt2-msg')?.value || '';
    NT.closeReason = document.getElementById('nt2-close-reason')?.value ?? NT.closeReason;
    for (const file of input.files || []) {
      if (NT.files.length >= 20) { showToast('A reply can have up to 20 attached files.', 'warn'); break; }
      if (!file.size || file.size > 10 * 1024 * 1024) { showToast(`${file.name}: choose a non-empty file up to 10 MB.`, 'warn'); continue; }
      NT.files.push({ file, attachment: null });
    }
    renderStep2();
    document.getElementById('nt2-files')?.focus();
  },
  'nt.templateCategory': (ds, el) => {
    if (NT.busy) return;
    templateFilters[ds.templateStep].category = el.value;
    filterTemplateOptions(ds.templateStep);
  },
  'nt.afterSend': (ds, el) => {
    if (NT.busy) return;
    NT.message = document.getElementById('nt2-msg')?.value || '';
    NT.closeReason = document.getElementById('nt2-close-reason')?.value ?? NT.closeReason;
    NT.statusAfterSend = el.value;
    NT.closeReason = '';
    renderStep2();
  },
  'nt.languageChoice': (ds, el) => {
    el.removeAttribute('aria-invalid');
    document.getElementById('nt-language-error').hidden = true;
  },
  'nt.replyLanguage': (ds, el) => { NT.replyLanguage = el.value; },
  'nt.applyTemplate': (ds, el) => {
    // Keep a message the agent already drafted on step 2 (step 1 has no
    // message field, so clobbering it would be invisible). Priority is only
    // rewritten when the template actually carries one — matching the old
    // modal, which never reset a hand-picked priority.
    const before = NT.priority;
    applyTemplateToNT(el.value, { keepMessage: NT.messageTouched });
    const subj = document.getElementById('nt-subj');
    if (subj) subj.value = NT.subject;
    const cat = document.getElementById('nt-cat');
    if (cat) cat.value = NT.categoryValue;
    const pri = document.getElementById('nt-pri');
    if (pri && NT.priority !== before) pri.value = NT.priority;
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
  'nt.templateSearch': (ds, el) => {
    if (NT.busy) return;
    templateFilters[ds.templateStep].query = el.value;
    filterTemplateOptions(ds.templateStep);
  },
  'nt.custSearch': (ds, el) => renderSuggestions(el.value),
  // Typing in the drafting window marks the message as the agent's, so a
  // later template pick on a step-1 revisit won't overwrite it.
  'nt.msgInput':   (ds, el) => { NT.message = el.value; NT.messageTouched = true; },
});

registerMousedownActions({
  'nt.pick': (ds) => pickCustomer(ds.custId),
});
