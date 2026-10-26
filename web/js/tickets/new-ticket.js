// Full-page new-ticket composer. Creation happens only on explicit Save or Send.
// The existing ticket/draft/upload funnel remains responsible for retries.

import { AGENTS, CATEGORIES, CHANNELS, CUSTOMERS, TICKETS, TICKET_TEMPLATES, CANNED_RESPONSES } from '../core/data.js';
import { can } from '../core/permissions.js';
import { SESSION, CURRENT_TICKET, setComposeTabValue } from '../core/state.js';
import { updateNavBadges } from '../core/router.js';
import { showModal, closeModal } from '../core/modal.js';
import { registerActions, registerChangeActions, registerInputActions, registerMousedownActions } from '../core/event-delegation.js';
import { isFieldRequired, isFieldVisible } from '../layouts/index.js';
import { isAgentOOO, applyAssignmentRules } from './assignment-rules.js';
import { refreshTicketSLA } from './sla.js';
import { fireWebhook, ticketPayload } from '../webhooks/index.js';
import { apiGet, apiPost, apiPatch, apiUpload, getJwt, getWorkspaceId } from '../core/api-client.js';
import { updateOrInsertTicket, loadTicketDetail } from '../core/bootstrap.js';
import { openTicket, notifyReplyDelivery, applySentStatus } from './detail.js';
import { matchesContact } from '../customers/contacts.js';
import { saveDraft, saveDraftRecipients, saveDraftAttachments, flushPersonalDraft, prepareDraftSend, finishDraftSend, textHtml } from './drafts.js';
import { mountComposer, disposeComposer, getHtml, getPlainText, setText, setHtml, isRich } from './composer.js';
import { appendTemplate, resolveTemplate, unresolvedVariables } from './template-content.js';
import { showMacroPanel } from './macros.js';
import { favouritesRow, loadTemplateFavourites, templateKey } from './template-favourites.js';
import { callClaude } from '../ai/client.js';
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

// Unsubmitted work stays local until the agent explicitly saves or sends.
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
  agentName: '',
  message: '',
  messageHtml: null,
  cc: '',
  sendingChannel: '',
  sendingInboxes: [],
  active: false,
  scope: null,
  editor: null,
  aiBusy: false,
  review: null,
  messageTouched: false, // the AGENT edited the message (vs a template filling it)
  replyLanguage: '',
  statusAfterSend: '',
  closeReason: '',
  files: [],
  createdTicket: null,
};

const templateFilters = { nt: { query: '', category: '' }, nt2: { query: '', category: '' } };
const backgroundInert = new Map();

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
  NT.messageHtml = null;
  NT.cc = '';
  NT.sendingChannel = '';
  NT.sendingInboxes = [];
  NT.active = false;
  NT.scope = null;
  NT.editor = null;
  NT.aiBusy = false;
  NT.review = null;
  NT.messageTouched = false;
  NT.replyLanguage = '';
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
let openingRequest = 0;
export async function showNewTicketModal(templateId, custDisplayId) {
  if (NT.active) { cancelWorkspace(); if (NT.active) return; }
  if (!can('tickets.create')) { showToast('Your role does not allow ticket creation.'); return; }
  const request = ++openingRequest, user = SESSION?.userId || null;
  const workspace = getWorkspaceId(), jwt = getJwt();
  if (workspace) await loadStatusOptions();
  if (request !== openingRequest || user !== (SESSION?.userId || null) || workspace !== getWorkspaceId() || jwt !== getJwt()) return;
  if (!statusOptionsState().ready) { showToast('Reload ticket statuses before creating a ticket.'); return; }
  resetNT();
  if (workspace && jwt) {
    let inboxes = [];
    try { inboxes = (await apiGet('/api/v1/channels/sending-inboxes')).inboxes || []; }
    catch { showToast('Sending inboxes could not be loaded. The workspace default sender is still available.', 'warn'); }
    if (request !== openingRequest || user !== (SESSION?.userId || null) || workspace !== getWorkspaceId() || jwt !== getJwt()) return;
    NT.sendingInboxes = inboxes;
  } else NT.sendingInboxes = CHANNELS.filter(c => c.type === 'email' && c.status === 'active').map(c => ({ id: c.id, address: c.address }));
  if (templateId) applyTemplateToNT(templateId);
  if (custDisplayId) {
    const c = CUSTOMERS.find(x => x.id === custDisplayId && !x.mergedInto);
    if (c) NT.customer = customerRef(c);
  }
  NT.active = true;
  NT.scope = { workspace, jwt, user: SESSION?.userId || null };
  const customer = CUSTOMERS.find(c => c.id === NT.customer?.displayId);
  NT.replyLanguage = TRANSLATOR_LANGS.includes(customer?.preferredLanguage) ? customer.preferredLanguage : jurisdictionLanguage(customer?.jurisdiction || '');
  closeModal();
  renderWorkspace();
  void loadTemplateFavourites();
}

function customerRef(c) {
  return { uuid: c._uuid || null, displayId: c.id, label: `${c.first} ${c.last}`.trim() || c.id };
}

// Keep agent edits; a previous template's untouched wording may be replaced.
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
    <label class="form-label" for="${prefix}-template">${prefix === 'nt' ? 'Start from ticket template (optional)' : 'Insert template (appends)'}</label>
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

function detailsHtml() {
  const cats = catOptions();

  const customerRow = visible('customerId')
    ? `<div class="form-row"><label class="form-label" for="nt-cust-search">Customer${reqMark('customerId')}</label><div id="nt-cust-box">${custBoxHtml()}</div></div>`
    : '';
  const categoryRow = visible('category')
    ? `<div class="form-row"><label class="form-label" for="nt-cat">Category${reqMark('category')}</label>
        <select class="form-input" id="nt-cat">
          <option value="" disabled hidden ${NT.categoryValue ? '' : 'selected'}>Select a category…</option>
          ${cats.map(o => `<option value="${window.escAttr(o.value)}" ${NT.categoryValue === o.value ? 'selected' : ''}>${window.escHtml(o.label)}</option>`).join('')}
        </select>
      </div>`
    : '';
  const priorityRow = visible('priority')
    ? `<div class="form-row"><label class="form-label" for="nt-pri">Priority${reqMark('priority')}</label>
        <select class="form-input" id="nt-pri">${['normal', 'high', 'urgent', 'low'].map(p => `<option ${NT.priority === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
      </div>`
    : '';
  // Deactivated members are excluded: the server refuses them (400 "not an
  // active member"), which would fail the create at the very last step.
  // Option VALUES are user ids, not names — names aren't unique (mapAgentRow
  // falls back to email, then 'Unknown'), and a name-based lookup miss would
  // silently drop the agent's deliberate pick.
  const agentRow = visible('agent')
    ? `<div class="form-row"><label class="form-label" for="nt-agent">Assign to${reqMark('agent')}</label>
        <select class="form-input" id="nt-agent">
          <option value="__auto__" ${NT.agentUserId ? '' : 'selected'}>Auto (apply rules)</option>
          ${AGENTS.filter(a => a.active !== false).map(a => `<option value="${window.escAttr(a.userId || a.name)}" ${NT.agentUserId === (a.userId || a.name) ? 'selected' : ''}>${window.escHtml(a.name)}${isAgentOOO(a.name) ? ' (OOO)' : ''}</option>`).join('')}
        </select>
      </div>`
    : '';

  return `
    ${templateControls('nt')}
    ${customerRow}
    ${visible('subject') ? `<div class="form-row"><label class="form-label" for="nt-subj">Subject${reqMark('subject')}</label><input class="form-input" id="nt-subj" value="${window.escAttr(NT.subject)}" placeholder="Describe the issue…"/></div>` : ''}
    ${categoryRow || priorityRow ? `<div class="form-grid">${categoryRow}${priorityRow}</div>` : ''}
    ${agentRow}
    ${statusReasonField(statusChoice('open'), 'nt-status-reason', NT.statusReason)}
  `;
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
  }
  NT.customer = customerRef(c);
  const boxEl = document.getElementById('nt-cust-box');
  if (boxEl) boxEl.innerHTML = custBoxHtml();   // in-place swap — other fields keep their typed values
}

function clearCustomer() {
  NT.customer = null;
  NT.replyLanguage = '';
  const boxEl = document.getElementById('nt-cust-box');
  if (boxEl) { boxEl.innerHTML = custBoxHtml(); wireCustomerSearch(); }
}

// ─── Step 2 — drafting window ────────────────────────────────────────────────



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

function currentWorkspace() {
  return NT.active && NT.scope?.workspace === getWorkspaceId() && NT.scope?.jwt === getJwt()
    && NT.scope?.user === (SESSION?.userId || null);
}

function captureEditor() {
  if (!NT.active) return;
  if (isRich('new-ticket') || document.getElementById('compose-new-ticket')?.tagName === 'TEXTAREA') {
    NT.messageHtml = getHtml('new-ticket');
    NT.message = getPlainText('new-ticket') || (NT.messageHtml?.includes('<img') ? '[Image]' : '');
    const fallback = document.getElementById('nt2-msg');
    if (fallback) fallback.value = NT.message;
  } else {
    NT.message = document.getElementById('nt2-msg')?.value ?? NT.message;
  }
}

function harvestWorkspace() {
  harvestStep1();
  captureEditor();
  NT.cc = document.getElementById('nt2-cc')?.value || '';
  NT.sendingChannel = document.getElementById('nt2-from')?.value || '';
  NT.replyLanguage = document.getElementById('nt2-language')?.value ?? NT.replyLanguage;
  NT.closeReason = document.getElementById('nt2-close-reason')?.value ?? NT.closeReason;
}

function closeWorkspace() {
  disposeComposer('new-ticket');
  const container = document.getElementById('new-ticket-container');
  if (container) container.innerHTML = '';
  for (const [node, wasInert] of backgroundInert) node.inert = wasInert;
  backgroundInert.clear();
}

function hasUnfinishedTicket() {
  return !!(NT.subject || NT.categoryValue || NT.message || NT.messageHtml || NT.files.length || NT.createdTicket
    || NT.cc || NT.sendingChannel || NT.agentUserId || NT.priority !== 'normal');
}

function cancelWorkspace() {
  if (NT.busy) return;
  harvestWorkspace();
  const created = NT.createdTicket;
  if (!created && hasUnfinishedTicket() && !window.confirm('Discard this unfinished ticket? Choose Save as draft to keep it.')) return;
  if (created && NT.files.some(entry => !entry.attachment) && !window.confirm('Open the saved ticket draft? Files that have not uploaded will need to be selected again.')) return;
  if (created && currentWorkspace()) {
    const content = resolveTemplate({ text: NT.message, html: NT.messageHtml }, { id: created.row.display_id, customerId: NT.customer?.displayId, agent: NT.agentName || SESSION?.name });
    saveDraft(created.row.display_id, content.html || content.text, 'reply');
    saveDraftRecipients(created.row.display_id, { ...recipientPayload(), cc: NT.cc, ticket_channel_id: created.row.channel_id || null });
    setComposeTabValue('reply');
    closeWorkspace(); resetNT(); closeModal(); openTicket(created.row.display_id);
    return;
  }
  closeWorkspace(); resetNT(); closeModal();
  document.querySelector('[data-action="cust.newTicket"], [data-action="tickets.newTicket"]')?.focus();
}

function recipientPayload() {
  const customer = CUSTOMERS.find(c => c.id === NT.customer?.displayId);
  const channel = NT.sendingInboxes.find(c => c.id === NT.sendingChannel);
  return { source_message_id: null, mode: 'reply', to: customer?.email ? [customer.email] : [],
    cc: NT.cc.split(',').map(value => value.trim()).filter(Boolean),
    sending_channel_id: NT.sendingChannel || null, sending_address: channel?.address || null };
}

function newTicketContext() {
  return { id: 'new-ticket', pendingCreation: true, customerId: NT.customer?.displayId, agent: NT.agentName || SESSION?.name };
}

function insertResponse(template) {
  if (!currentWorkspace() || NT.busy || NT.aiBusy || !visible('message') || !can('tickets.reply')) return;
  harvestWorkspace();
  if (!NT.customer) { showToast('Choose a customer before inserting a response.', 'warn'); return; }
  return appendTemplate(newTicketContext(), template);
}

function renderWorkspace() {
  if (!currentWorkspace()) return;
  const container = document.getElementById('new-ticket-container');
  if (!container) return;
  const customer = CUSTOMERS.find(c => c.id === NT.customer?.displayId);
  const messageVisible = visible('message');
  const actions = sendActions();
  const action = actions.find(value => value.status === NT.statusAfterSend) || SEND_ACTIONS[0];
  const channels = NT.sendingInboxes;
  disposeComposer('new-ticket');
  container.innerHTML = `<section class="new-ticket-workspace" role="dialog" aria-modal="true" aria-labelledby="nt-heading" data-guide="new-ticket">
    <header class="nt-heading"><div><h1 id="nt-heading">New ticket</h1><p>${messageVisible ? 'Write the first message or save the details as a draft.' : 'Save the ticket details as a draft.'}</p></div><button type="button" class="btn" data-action="nt.cancel" aria-label="Close new ticket">Close</button></header>
    <div class="nt-workspace-body ${messageVisible ? '' : 'nt-details-only'}"><aside class="nt-details" aria-label="Ticket details">${detailsHtml()}
      ${customer ? `<dl class="nt-customer-context"><dt>Customer ID</dt><dd>${window.escHtml(customer.id)}</dd><dt>Email</dt><dd>${window.escHtml(customer.email || 'No primary email saved')}</dd><dt>Brand</dt><dd>${window.escHtml(customer.brand || 'Current workspace')}</dd><dt>Jurisdiction</dt><dd>${window.escHtml(customer.jurisdiction || 'Not set')}</dd></dl>` : ''}
    </aside>${messageVisible ? `<div class="nt-writing">
      ${NT.createdTicket ? `<p class="nt-saved-notice" role="status">Ticket ${window.escHtml(NT.createdTicket.row.display_id)} is saved. Continue here to retry; your ticket will not be created again.</p>` : ''}
      <div class="nt-recipients"><label for="nt2-from">From</label><select id="nt2-from" class="form-input"><option value="">Workspace default sender</option>${channels.map(c => `<option value="${window.escAttr(c.id)}" ${NT.sendingChannel === c.id ? 'selected' : ''}>${window.escHtml(c.address)}</option>`).join('')}</select>
      <span>To</span><span class="nt-to">${window.escHtml(customer?.email || 'Choose a customer with a usable email address')}</span>
      <label for="nt2-cc">Cc</label><input type="email" multiple id="nt2-cc" class="form-input" value="${window.escAttr(NT.cc)}" placeholder="Email addresses, separated by commas"></div>
      <div class="nt-writing-tools"><button type="button" class="btn" data-action="nt.responses" ${NT.aiBusy ? 'disabled' : ''}>Insert response template</button><button type="button" class="btn" data-action="nt.preview">Preview message</button>
      <label for="nt2-language">Reply language</label><select class="form-input" id="nt2-language"><option value="">As written</option>${TRANSLATOR_LANGS.map(lang => `<option ${NT.replyLanguage === lang ? 'selected' : ''}>${lang}</option>`).join('')}</select></div>
      <div class="template-favourites" id="nt-favourites" aria-label="Favourite response templates">${favouritesRow('new-ticket', 'nt.favourite')}</div>
      <label class="form-label" for="nt2-msg">Message to the customer</label>
      <div id="compose-new-ticket" class="compose-area compose-rich nt-rich-editor" data-rich="1" aria-label="Message to the customer" hidden></div>
      <textarea class="form-input nt-plain-editor" id="nt2-msg" data-input-action="nt.msgInput" placeholder="Write the first message…">${window.escHtml(NT.message)}</textarea>
      <div class="nt-ai-tools" role="group" aria-label="AI writing tools">${[['draft','Draft message'],['improve','Improve'],['shorten','Shorten'],['friendly','Make friendlier']].map(([verb,label]) => `<button type="button" class="btn btn-sm" data-action="nt.ai" data-verb="${verb}" ${!can('tools.ai') || NT.aiBusy ? 'disabled' : ''}>${label}</button>`).join('')}<span id="nt-ai-status" role="status">${NT.aiBusy ? 'Preparing suggestion…' : ''}</span></div>
      <div id="nt-ai-notes">${NT.review?.notes?.length ? `<aside class="nt-ai-notes" aria-label="Internal AI notes"><strong>Internal AI notes · not emailed</strong>${NT.review.notes.map(note => `<p>${window.escHtml(typeof note === 'string' ? note : note.text || '')}</p>`).join('')}</aside>` : ''}</div>
      ${renderNewTicketFiles()}
      <div class="nt-send-options"><label for="nt2-after-send">Send action</label><select id="nt2-after-send" class="form-input" data-change-action="nt.afterSend">${actions.map(a => `<option value="${window.escAttr(a.status)}" ${a.status === NT.statusAfterSend ? 'selected' : ''}>${window.escHtml(a.label)}</option>`).join('')}</select><p id="nt2-action-hint">${window.escHtml(action.hint)} Status changes happen only after the email is sent.</p>
      ${NT.statusAfterSend ? statusReasonField(statusChoice(NT.statusAfterSend), 'nt2-close-reason', NT.closeReason) : ''}</div>
    </div>` : ''}</div><footer class="nt-footer"><div><button type="button" class="btn" id="nt2-draft-btn" data-action="nt.saveDraft" ${NT.aiBusy ? 'disabled' : ''}>Save as draft</button><span>Save the details and unsent message. No customer email or survey.</span></div>
    ${messageVisible ? `<div><button type="button" class="btn" id="nt2-without-ai-btn" data-action="nt.sendWithoutAI" aria-describedby="nt2-without-ai-hint" ${NT.aiBusy || NT.statusAfterSend || !can('tickets.reply') ? 'disabled' : ''}>Send without AI…</button><button type="button" class="btn btn-solid" id="nt2-send-btn" data-action="nt.send" ${NT.aiBusy || !can('tickets.reply') ? 'disabled' : ''}>${window.escHtml(action.label)}</button><p id="nt2-without-ai-hint">${window.escHtml(SEND_WITHOUT_AI_HINT)}</p></div>` : ''}</footer>
  </section>`;
  for (const node of document.querySelectorAll('#app > .sidebar, #app > .main')) {
    if (!backgroundInert.has(node)) backgroundInert.set(node, node.inert);
    node.inert = true;
  }
  wireCustomerSearch();
  const host = document.getElementById('compose-new-ticket');
  const initialText = NT.message, initialHtml = NT.messageHtml;
  if (messageVisible) void mountComposer('new-ticket', { initialHtml: NT.messageHtml || textHtml(NT.message), readOnly: NT.busy || !can('tickets.reply'),
    placeholder: 'Write the first message…', onChange: () => { captureEditor(); NT.messageTouched = true; } }).then(editor => {
      if (!currentWorkspace() || document.getElementById('compose-new-ticket') !== host) return;
      NT.editor = editor;
      if (editor) {
        if (NT.message !== initialText || NT.messageHtml !== initialHtml) {
          if (NT.messageHtml) setHtml('new-ticket', NT.messageHtml); else setText('new-ticket', NT.message);
        }
        host.hidden = false;
      } else {
        host.outerHTML = `<textarea id="compose-new-ticket" class="form-input nt-plain-editor" data-input-action="nt.msgInput" aria-label="Message to the customer">${window.escHtml(NT.message)}</textarea>`;
      }
      const input = editor?.root || document.getElementById('compose-new-ticket');
      input.setAttribute('aria-label', 'Message to the customer');
      if (editor) { input.setAttribute('role', 'textbox'); input.setAttribute('aria-multiline', 'true'); }
      else input.readOnly = NT.busy || !can('tickets.reply');
      document.getElementById('nt2-msg').hidden = true;
    }).catch(() => { /* The plain-text editor remains available. */ });
  if (NT.createdTicket) for (const node of container.querySelectorAll('.nt-details input,.nt-details select,.nt-details button')) node.disabled = true;
  if (NT.aiBusy || !can('tickets.reply')) for (const node of container.querySelectorAll('[data-action="nt.responses"], [data-action="nt.favourite"], [data-action="nt.ai"]')) node.disabled = true;
  container.querySelector('.new-ticket-workspace').addEventListener('keydown', event => {
    // Keep app navigation shortcuts out of an unfinished conversation.
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); cancelWorkspace(); return; }
    if (messageVisible && event.code === 'Space' && (event.ctrlKey || event.metaKey) && event.shiftKey) {
      event.preventDefault();
      if (!NT.busy && !NT.aiBusy && can('tickets.reply')) showMacroPanel('new-ticket', insertResponse);
    }
    if (event.key !== 'Tab') return;
    const nodes = [...container.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[contenteditable="true"]')].filter(node => !node.hidden && node.getClientRects().length);
    if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
  });
  document.getElementById('nt-subj')?.focus();
}

async function aiWriting(verb) {
  if (!currentWorkspace() || NT.busy || NT.aiBusy || !visible('message') || !can('tools.ai') || !can('tickets.reply')) return;
  harvestWorkspace();
  const original = NT.message, originalHtml = NT.messageHtml, scope = NT.scope, customer = NT.customer;
  const editor = document.getElementById('compose-new-ticket');
  if (!original.trim() && (verb !== 'draft' || !NT.subject.trim())) { showToast('Enter a subject or write a message first.', 'warn'); return; }
  NT.aiBusy = true;
  document.querySelectorAll('[data-action="nt.ai"], [data-action="nt.responses"], [data-action="nt.favourite"], #nt2-send-btn, #nt2-draft-btn, #nt2-without-ai-btn').forEach(node => { node.disabled = true; });
  document.getElementById('nt-ai-status').textContent = 'Preparing suggestion…';
  try {
    const instruction = { draft: 'Draft a concise first customer-support message from the supplied subject and agent notes. Do not invent facts.', improve: 'Improve clarity without changing the meaning.', shorten: 'Shorten while preserving the meaning.', friendly: 'Make the tone warmer without changing the meaning.' }[verb];
    const result = await callClaude({ action: 'draft', system: instruction, messages: [{ role: 'user', content: `Subject: ${NT.subject}\nAgent notes or message:\n${original}` }], replyFormat: true, replyContext: 'reply', maxTokens: 1600 });
    if (!currentWorkspace() || NT.scope !== scope) return;
    if (NT.customer !== customer || document.getElementById('compose-new-ticket') !== editor) {
      showToast('The ticket changed while AI was working. Your message was kept. Generate the suggestion again.', 'warn'); return;
    }
    captureEditor();
    if (NT.message !== original || NT.messageHtml !== originalHtml) { showToast('Your edits were kept. Generate the suggestion again.', 'warn'); return; }
    if (!result.text?.trim() || !result.data?.internal) throw Error('The suggestion was incomplete. Please try again.');
    NT.review = result.data.internal;
    setText('new-ticket', result.text); captureEditor(); NT.messageTouched = true;
    document.getElementById('nt-ai-notes').innerHTML = `<aside class="nt-ai-notes" aria-label="Internal AI notes"><strong>Internal AI notes · not emailed</strong>${(NT.review.notes || []).map(note => `<p>${window.escHtml(typeof note === 'string' ? note : note.text || '')}</p>`).join('')}</aside>`;
    showToast('Suggestion inserted. Review it before sending.');
  } catch (error) { if (currentWorkspace() && NT.scope === scope) showToast(error.message || 'Could not prepare a suggestion.', 'error'); }
  finally { if (currentWorkspace() && NT.scope === scope) { NT.aiBusy = false; setBusy(false); document.getElementById('nt-ai-status').textContent = ''; } }
}

window.addEventListener('beforeunload', event => {
  if (!currentWorkspace()) return;
  harvestWorkspace();
  if (hasUnfinishedTicket()) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('respovia:auth-scope-changed', () => { closeWorkspace(); resetNT(); });
window.addEventListener('respovia:session-expired', () => { closeWorkspace(); resetNT(); });
window.addEventListener('respovia:clear-drafts', event => {
  if (NT.active && (!event.detail?.userId || event.detail.userId === SESSION?.userId)) { closeWorkspace(); resetNT(); }
});
window.addEventListener('respovia:template-favourites', () => {
  const target = document.getElementById('nt-favourites');
  if (currentWorkspace() && target) {
    target.innerHTML = favouritesRow('new-ticket', 'nt.favourite');
    if (NT.busy || NT.aiBusy || !can('tickets.reply')) for (const node of target.querySelectorAll('button')) node.disabled = true;
  }
});


// Freeze every exit while saving, so cancellation cannot reset in-flight work.
function setBusy(on, label) {
  NT.busy = on;
  NT.editor?.enable(!on && can('tickets.reply'));
  document.querySelectorAll('#new-ticket-container input, #new-ticket-container textarea, #new-ticket-container select')
    .forEach(el => { el.disabled = on; });
  const confirm = document.getElementById('nt2-send-btn');
  if (confirm) {
    confirm.textContent = on ? label : (sendActions().find(action => action.status === NT.statusAfterSend) || SEND_ACTIONS[0]).label;
    confirm.disabled = on || !can('tickets.reply');
  }
  const draft = document.getElementById('nt2-draft-btn');
  if (draft) draft.disabled = on;
  const manualSend = document.getElementById('nt2-without-ai-btn');
  if (manualSend) manualSend.disabled = on || NT.statusAfterSend;
  document.querySelectorAll('#new-ticket-container button').forEach(el => { el.disabled = on || (el.dataset.action === 'nt.ai' && !can('tools.ai')) || (['nt.send','nt.sendWithoutAI','nt.ai','nt.responses','nt.favourite'].includes(el.dataset.action) && !can('tickets.reply')) || (el.dataset.action === 'nt.sendWithoutAI' && !!NT.statusAfterSend); });
  if (NT.createdTicket) document.querySelectorAll('#new-ticket-container .nt-details input, #new-ticket-container .nt-details select, #new-ticket-container .nt-details button').forEach(node => { node.disabled = true; });
  document.querySelectorAll('#new-ticket-container [data-action="nt.cancel"]')
    .forEach(el => {
      if (el.tagName === 'BUTTON') el.disabled = on;
      el.style.pointerEvents = on ? 'none' : '';
      el.style.opacity = on ? '.5' : '';
    });
}

async function confirmSend(withoutAI = false) {
  if (!currentWorkspace() || NT.busy || NT.aiBusy || !visible('message') || !can('tickets.create') || !can('tickets.reply')) return;
  harvestWorkspace();
  if (!validateStep1(catOptions().length)) return;
  const ccInput = document.getElementById('nt2-cc');
  if (ccInput && !ccInput.checkValidity()) { ccInput.reportValidity(); return; }
  if (!recipientPayload().to.length) { showToast('Save a usable primary email on the customer before sending.', 'warn'); return; }
  if (withoutAI && NT.statusAfterSend) return;
  const msg = document.getElementById('nt2-msg')?.value.trim() || '';
  NT.message = msg;
  if (NT.files.length && !msg) { alert('Write a message to send attachments, or choose Save as draft.'); return; }
  if (NT.files.reduce((size, entry) => size + entry.file.size, 0) > 7 * 1024 * 1024) { alert('Attachments are too large to email (max 7 MB in total). Remove some files or save as draft.'); return; }
  if (!msg) { alert('Write a first message to send, or choose Save as draft.'); return; }
  if (unresolvedVariables(NT.messageHtml || msg).some(key => key.toLowerCase() !== '{ticket}')) { alert('Fill in the template fields before sending.'); return; }
  if (withoutAI && msg && !window.confirm('Send without AI?\n\nYour message and subject will not be translated. The header, signature and footer will use their saved wording. Check that the customer can understand them.')) return;
  setBusy(true, msg ? 'Sending…' : 'Creating…');
  if (NT.statusAfterSend) {
    if (!can('tickets.edit') || !can('tickets.close')) { setBusy(false); showToast('Your role does not allow changing ticket status.', 'error'); return; }
    const workspace = getWorkspaceId(), jwt = getJwt(), form = document.getElementById('nt2-msg');
    await loadStatusOptions(true);
    if (form?.isConnected === false) return;
    if (workspace !== getWorkspaceId() || jwt !== getJwt()) { closeModal(); closeWorkspace(); resetNT(); return; }
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
  if (!currentWorkspace() || NT.busy || NT.aiBusy || !can('tickets.create')) return;
  harvestWorkspace();
  if (!validateStep1(catOptions().length)) return;
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
  const scope = NT.scope;
  try {
    await runCreate(args);
  } catch (err) {
    if (!currentWorkspace() || NT.scope !== scope) return;
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
    messageHtml: visible('message') ? NT.messageHtml : null,
    recipients: recipientPayload(),
    files: visible('message') ? [...NT.files] : [],
  };
  let displayId, keptDraft = false, emailed = false;
  if (isApiBacked) {
    if (send && message && !withoutAI) {
      const prepared = await prepareCustomerReply({ autoTranslateReplies: !!snapshot.replyLanguage,
        customerLanguageManual: !!snapshot.replyLanguage, detectedCustomerLang: snapshot.replyLanguage || null }, message, snapshot.messageHtml);
      if (!prepared.replyLanguage) throw new Error('Choose a reply language before sending. Your draft has been kept.');
      if (workspace !== getWorkspaceId() || jwt !== getJwt()) throw new Error('Your workspace or session changed. Reopen the ticket form before sending.');
      message = prepared.translation;
      snapshot.messageHtml = prepared.translationHtml || null;
      snapshot.replyLanguage = prepared.replyLanguage;
    }
    if (form?.isConnected === false) return;
    const res = await createOnServer(snapshot, { message, send });
    if (form?.isConnected === false) return;
    if (workspace !== getWorkspaceId() || jwt !== getJwt()) { closeModal(); closeWorkspace(); resetNT(); return; }
    // Upload retries retain the created ticket; other failures open its draft.
    if (!res) { setBusy(false); return; }
    if (res.retry) { setBusy(false); renderWorkspace(); return; }
    if (res.aborted) {
      setBusy(false); closeModal(); closeWorkspace(); resetNT();
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
  closeWorkspace();
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
  NT.createdTicket = { row, workspace, jwt };
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

  return createWithFiles(row, snap, { message, send }, current);
}

async function createWithFiles(row, snap, { message, send }, current) {
  try {
    const resolved = resolveTemplate({ text: message, html: snap.messageHtml }, { id: row.display_id, customerId: snap.customerDisplayId, agent: snap.agentName || SESSION?.name });
    message = resolved.text; snap.messageHtml = resolved.html;
    if (send && unresolvedVariables(snap.messageHtml || message).length) throw Error('Fill in the remaining template fields before sending.');
    saveDraft(row.display_id, snap.messageHtml || message, 'reply');
    saveDraftRecipients(row.display_id, { ...snap.recipients, cc: snap.recipients.cc.join(', '), ticket_channel_id: row.channel_id || null });
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
    showToast(`Ticket ${row.display_id} is saved, but its draft is not fully saved. No message was sent. Retry here. ${error.message}`, 'warn', 10000);
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
      body_html: snap.messageHtml || undefined, email_recipients: snap.recipients,
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

// Demo persona — the same workflow without API writes.
function createDemoTicket(snap, { message, send }) {
  // parseInt on non-numeric IDs returns NaN; filter them out so a stray
  // ticket like "TK-foo" can't poison Math.max into NaN.
  const ticketNums = TICKETS.map(t => parseInt((t.id || '').split('-')[1] || '0', 10)).filter(n => Number.isFinite(n));
  const newId = 'TK-' + String(Math.max(0, ...ticketNums) + 1).padStart(3, '0');
  const resolved = resolveTemplate({ text: message, html: snap.messageHtml }, { id: newId, customerId: snap.customerDisplayId, agent: snap.agentName || SESSION?.name });
  message = resolved.text; snap.messageHtml = resolved.html;
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
  const keptDraft = !send;
  if (keptDraft) {
    saveDraft(newId, snap.messageHtml || message, 'reply');
    saveDraftRecipients(newId, { ...snap.recipients, cc: snap.recipients.cc.join(', ') });
  }
  return { displayId: newId, keptDraft };
}

registerActions({
  'nt.clearCust': () => { if (NT.busy || NT.createdTicket) return; harvestWorkspace(); clearCustomer(); renderWorkspace(); },
  'nt.send': () => { void confirmSend(); },
  'nt.sendWithoutAI': () => { void confirmSend(true); },
  'nt.saveDraft': () => { void saveAsDraft(); },
  'nt.cancel': cancelWorkspace,
  'nt.responses': () => { if (currentWorkspace() && !NT.busy && !NT.aiBusy && visible('message') && can('tickets.reply')) showMacroPanel('new-ticket', insertResponse); },
  'nt.favourite': ds => { const template = CANNED_RESPONSES.find(t => templateKey(t) === ds.templateKey); if (template) void insertResponse(template); },
  'nt.ai': ds => { void aiWriting(ds.verb); },
  'nt.preview': () => {
    if (!currentWorkspace()) return;
    harvestWorkspace();
    const html = NT.messageHtml || textHtml(NT.message);
    const doc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>body{font:14px/1.5 sans-serif;overflow-wrap:anywhere}img{max-width:100%}</style>${html}`;
    showModal('Preview message', `<p>This shows your message as written. Sending applies the selected language and saved email branding.</p><iframe class="nt-message-preview" title="Message preview" tabindex="-1" sandbox="" srcdoc="${window.escAttr(doc)}"></iframe><button type="button" class="btn" data-action="nt.closePreview">Close preview</button>`, null, null, true);
    const modal = document.querySelector('#modal-container .modal');
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', 'Preview message');
    const close = modal.querySelector('[data-action="nt.closePreview"]'); close.focus();
    modal.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Tab') { event.preventDefault(); close.focus(); }
      if (event.key === 'Escape') { event.preventDefault(); closeModal(); document.querySelector('[data-action="nt.preview"]')?.focus(); }
    });
  },
  'nt.closePreview': () => { closeModal(); document.querySelector('[data-action="nt.preview"]')?.focus(); },
  'nt.removeFile': ds => {
    if (!currentWorkspace() || NT.busy) return;
    harvestWorkspace();
    NT.files.splice(Number(ds.index), 1);
    if (NT.createdTicket) saveDraftAttachments(NT.createdTicket.row.display_id, NT.files.filter(entry => entry.attachment).map(entry => entry.attachment));
    renderWorkspace(); document.getElementById('nt2-files')?.focus();
  },
});

registerChangeActions({
  'nt.files': (_, input) => {
    if (!currentWorkspace() || NT.busy || !can('tickets.attach') || !can('tickets.reply')) return;
    harvestWorkspace();
    for (const file of input.files || []) {
      if (NT.files.length >= 20) { showToast('A reply can have up to 20 attached files.', 'warn'); break; }
      if (!file.size || file.size > 10 * 1024 * 1024) { showToast(`${file.name}: choose a non-empty file up to 10 MB.`, 'warn'); continue; }
      NT.files.push({ file, attachment: null });
    }
    renderWorkspace(); document.getElementById('nt2-files')?.focus();
  },
  'nt.templateCategory': (ds, el) => { if (!NT.busy) { templateFilters[ds.templateStep].category = el.value; filterTemplateOptions(ds.templateStep); } },
  'nt.afterSend': (_, el) => {
    if (!currentWorkspace() || NT.busy) return;
    harvestWorkspace(); NT.statusAfterSend = el.value; NT.closeReason = ''; renderWorkspace();
    document.getElementById('nt2-after-send')?.focus();
  },
  'nt.applyTemplate': (_, el) => {
    if (!currentWorkspace() || NT.busy || NT.createdTicket) return;
    harvestWorkspace();
    if (NT.messageTouched && !window.confirm('Apply this ticket template? Your written message will be kept; the subject, category and priority may change.')) { el.value = NT.templateId || ''; return; }
    applyTemplateToNT(el.value, { keepMessage: NT.messageTouched });
    if (!NT.messageTouched) NT.messageHtml = null;
    renderWorkspace();
  },
});

registerInputActions({
  'nt.templateSearch': (ds, el) => { if (!NT.busy) { templateFilters[ds.templateStep].query = el.value; filterTemplateOptions(ds.templateStep); } },
  'nt.custSearch': (_, el) => renderSuggestions(el.value),
  'nt.msgInput': (_, el) => { if (!currentWorkspace()) return; NT.message = el.value; NT.messageHtml = null; NT.messageTouched = true; const copy = document.getElementById('nt2-msg'); if (copy) copy.value = el.value; },
});

registerMousedownActions({
  'nt.pick': ds => {
    if (!currentWorkspace() || NT.busy || NT.createdTicket) return;
    harvestWorkspace(); pickCustomer(ds.custId);
    const customer = CUSTOMERS.find(c => c.id === NT.customer?.displayId);
    NT.replyLanguage = TRANSLATOR_LANGS.includes(customer?.preferredLanguage) ? customer.preferredLanguage : jurisdictionLanguage(customer?.jurisdiction || '');
    NT.cc = ''; NT.review = null; renderWorkspace();
    if (NT.message) showToast('Customer changed. Review the recipient and message before sending.', 'warn');
  },
});
