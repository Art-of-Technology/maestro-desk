// ─── Customer details card — pinned, editable ────────────────────────────────
// The profile's first block (Phase 4, PR 6): identity strip + every profile
// field + all email / mobile addresses, sticky at the top of .page-scroll so
// the customer's details never leave the screen while an agent scrolls the
// tickets and history below. It absorbed the old avatar header, the half-
// width "Profile" card, the Consent stats tile and the Backoffice quick
// action, so nothing on the page is shown twice. While stuck it condenses to
// one line (name · badges · primary email · primary mobile · Edit) and a
// spacer takes the height it gave up, so scrollHeight doesn't shrink under
// the reader (which would clamp scrollTop, let the sentinel back in, and make
// the card flicker between states on short pages).
//
// Editing = a form modal, then an "are you sure?" step that lists every
// change before → after (Jodi's precaution), then PATCH /customers/:id —
// which returns the full GET /customers row, applied locally through
// bootstrap.js applyCustomerRow. Emails / mobiles are NOT in the form: they
// are contact rows with their own add / remove / make-primary endpoints, each
// its own audited action, driven by the buttons on the pills. Merged-away and
// erased profiles render read-only (no Edit, no address controls).
//
// Rows follow the admin field layout (Layouts → Customers): order, and a
// hidden field disappears from the card AND from the edit form. Maestro ids
// are server-owned (auto-link) — shown, never editable.
//
// Real rows (c._uuid) persist; demo personas mutate CUSTOMERS in memory,
// mirroring the server rules (one primary per kind, last email can't go).
// One modal at a time (core/modal.js): the two edit steps are separate
// showModal calls with state carried in the module-local ED object.
//
// External reaches (interim, via window): escAttr, escHtml — still in app.js.

import { CUSTOMERS } from '../core/data.js';
import { renderPage } from '../core/router.js';
import { showModal, closeModal, showDangerConfirm } from '../core/modal.js';
import { registerActions, registerInputActions } from '../core/event-delegation.js';
import { isFieldVisible, getLayoutFields } from '../layouts/index.js';
import { apiPatch, apiPost, apiDelete } from '../core/api-client.js';
import { applyCustomerRow } from '../core/bootstrap.js';
import { contactArrays, applyContacts } from './contacts.js';
import { showToast } from '../core/toast.js';

// ─── Field model ─────────────────────────────────────────────────────────────
// Layout key → API column + input type. `vm` is the view-model key when it
// differs from the layout key. Everything the form can edit is here; the
// PATCH whitelist on the server is the mirror of this list.
const EDITABLE = {
  first:          { col: 'first_name',     label: 'First name',        type: 'text' },
  last:           { col: 'last_name',      label: 'Last name',         type: 'text' },
  username:       { col: 'username',       label: 'Username',          type: 'text',   mono: true },
  brand:          { col: 'brand',          label: 'Brand',             type: 'text' },
  vip:            { col: 'vip_tier',       label: 'VIP tier',          type: 'select', options: ['Platinum', 'Gold', 'Silver', 'Bronze'] },
  jurisdiction:   { col: 'jurisdiction',   label: 'Jurisdiction',      type: 'text',   placeholder: 'UK' },
  since:          { col: 'since',          label: 'Customer since',    type: 'date' },
  consent:        { col: 'consent',        label: 'Marketing consent', type: 'bool' },
  backoffice_url: { col: 'backoffice_url', label: 'Backoffice link',   type: 'url',    vm: 'bo', placeholder: 'https://' },
};
const vmKey = (key) => EDITABLE[key]?.vm || key;

// Current value in the form's normalised terms: booleans stay booleans, blank
// strings are null — the same normalisation the server applies, so the diff
// can't report a change the server would then ignore.
function currentValue(c, key) {
  if (key === 'consent') return Boolean(c.consent);
  const v = c[vmKey(key)];
  const s = v == null ? '' : String(v).trim();
  return s || null;
}
function fmtValue(key, v) {
  if (key === 'consent') return v ? 'Yes' : 'No';
  return v == null || v === '' ? '—' : String(v);
}

// ─── Render ──────────────────────────────────────────────────────────────────
const esc  = (s) => window.escHtml(s == null ? '' : String(s));
const attr = (s) => window.escAttr(s == null ? '' : String(s));
const mono = (s) => `<span style="font-family:var(--font-mono)">${esc(s)}</span>`;

// Read-only / display renderers for the fields grid. email + mobile are not
// here — they render as the address rows below. first/last are headerOwned
// (the identity strip shows the name). Anything the layout lists that has no
// renderer here is skipped, so a future field can't interpolate "undefined".
const ROW_RENDERERS = {
  username:      (c) => c.username ? mono(c.username) : '<span class="muted">—</span>',
  // Maestro identity — server-written by the auto-link, read-only here. An
  // unlinked contact says so rather than showing a blank cell.
  maestroUserId: (c) => c.maestroUserId ? mono(c.maestroUserId) : '<span class="muted">Not linked</span>',
  memberId:      (c) => c.memberId ? mono(c.memberId) : '<span class="muted">—</span>',
  brand:         (c) => c.brand ? esc(c.brand) : '<span class="muted">—</span>',
  vip:           (c) => c.vip ? `<span class="vip-badge vip-${attr((c.vip || '').toLowerCase())}">${esc(c.vip)}</span>` : '<span class="muted">—</span>',
  jurisdiction:  (c) => c.jurisdiction ? mono(c.jurisdiction) : '<span class="muted">—</span>',
  since:         (c) => c.since ? esc(c.since) : '<span class="muted">—</span>',
  consent:       (c) => `<span style="color:${c.consent ? 'var(--green)' : 'var(--red)'}">${c.consent ? 'Yes' : 'No'}</span>`,
  // Same http(s) guard the old quick-action button had: a non-URL value is
  // shown as text rather than turned into a link.
  backoffice_url: (c) => !c.bo ? '<span class="muted">—</span>'
    : /^https?:\/\//i.test(c.bo)
      ? `<a href="${attr(c.bo)}" target="_blank" rel="noopener" style="color:var(--ink)">Open in backoffice ↗</a>`
      : esc(c.bo),
};

// Hard / spam bounces are the actionable cases (mail won't deliver); soft
// bounces accumulate silently in the count. Per contact row now — the legacy
// synthesised primary (no contact row yet) falls back to the profile's
// scalar bounce state, which is the same address.
function bounceBadge(x, c) {
  const legacy = x.id == null && x.is_primary;
  const state = (x.bounce_state ?? (legacy ? c.emailBounceState : 'none')) || 'none';
  if (state !== 'hard' && state !== 'spam') return '';
  const count = x.bounce_count ?? (legacy ? c.emailBounceCount : 0) ?? 0;
  const label = state === 'spam' ? 'SPAM' : 'BOUNCING';
  const title = `${state === 'spam' ? 'Marked as spam' : 'Email bouncing'} — ${count} event${count === 1 ? '' : 's'}`;
  return `<span title="${attr(title)}" style="display:inline-block;padding:1px 6px;font-size:10px;font-weight:600;color:var(--red);background:var(--red-lt);border:1px solid var(--red-bd);border-radius:3px;font-family:var(--font-mono)">${label}</span>`;
}

function renderAddressRow(c, kind, locked) {
  // Primary first, then the server's order (creation) — the server lists by
  // created_at, so a later-promoted primary would otherwise sit mid-row.
  const list = [...contactArrays(c)[kind === 'email' ? 'emails' : 'mobiles']]
    .sort((a, b) => Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary)));
  const noun = kind === 'email' ? 'email' : 'mobile';
  const pills = list.map((x) => {
    const controls = (!x.is_primary && !locked) ? `
        <button type="button" class="cust-addr-ctl" data-action="cust.setPrimaryContact" data-cust-id="${attr(c.id)}" data-kind="${kind}" data-contact-id="${attr(x.id || '')}" data-value="${attr(x.value)}" title="Make primary" aria-label="Make ${attr(x.value)} the primary ${noun}">☆</button>
        <button type="button" class="cust-addr-ctl" data-action="cust.removeContact" data-cust-id="${attr(c.id)}" data-kind="${kind}" data-contact-id="${attr(x.id || '')}" data-value="${attr(x.value)}" title="Remove" aria-label="Remove ${attr(x.value)}">×</button>` : '';
    return `<span class="cust-addr-pill${x.is_primary ? ' is-primary' : ''}">
        <span class="cust-addr-val">${esc(x.value)}</span>
        ${x.is_primary ? '<span class="cust-addr-primary">PRIMARY</span>' : ''}
        ${kind === 'email' ? bounceBadge(x, c) : ''}${controls}
      </span>`;
  }).join('\n      ');
  const add = locked ? '' : `<button type="button" class="cust-addr-add" data-action="cust.addContact" data-cust-id="${attr(c.id)}" data-kind="${kind}">+ Add ${noun}</button>`;
  const empty = (!list.length && locked) ? '<span class="muted" style="font-size:12px;color:var(--ink3)">—</span>' : '';
  return `<div class="cust-pin-k">${kind === 'email' ? 'Emails' : 'Mobiles'}</div>
    <div class="cust-addr">${pills}${empty}${add}</div>`;
}

// The primary email / mobile spans are `cust-pin-stuck-only`: hidden at rest
// (the address rows below show every address) and revealed while the card is
// stuck and the body is hidden, so the one-line state still carries them.
function identityMeta(c) {
  const parts = [mono(c.id)];
  if (c.vip) parts.push(`<span class="vip-badge vip-${attr((c.vip || '').toLowerCase())}">${esc(c.vip)}</span>`);
  if (c.brand) parts.push(`<span>${esc(c.brand)}</span>`);
  if (c.jurisdiction) parts.push(mono(c.jurisdiction));
  if (c.email)  parts.push(`<span class="cust-pin-stuck-only">${esc(c.email)}</span>`);
  if (c.mobile) parts.push(`<span class="cust-pin-stuck-only">${esc(c.mobile)}</span>`);
  if (c.mergedInto) parts.push(`<span class="tag" style="background:var(--purple-lt);color:var(--purple);border:1px solid var(--purple)">Merged → ${esc(c.mergedInto)}</span>`);
  if (c.erased) parts.push('<span class="tag tag-gdpr">Erased</span>');
  return parts.join('');
}

// The card + its sticky scaffolding (sentinel above, spacer below). Returns
// HTML; customers/index.js places it first inside .page-scroll.
export function renderDetailsCard(c) {
  const locked = Boolean(c.mergedInto || c.erased);
  const initials = `${(c.first || '').charAt(0)}${(c.last || '').charAt(0)}`;
  const editBtn = locked ? '' : `<button type="button" class="btn btn-sm" data-action="cust.editDetails" data-cust-id="${attr(c.id)}">✎ Edit details</button>`;

  const fields = getLayoutFields('customer')
    .filter((f) => !f.headerOwned && isFieldVisible('customer', f.key) && Object.hasOwn(ROW_RENDERERS, f.key))
    .map((f) => `<div class="cust-pin-f"><div class="cust-pin-k">${esc(f.label)}</div><div class="cust-pin-v">${ROW_RENDERERS[f.key](c)}</div></div>`)
    .join('\n        ');
  const addressRows = ['email', 'mobile']
    .filter((k) => isFieldVisible('customer', k))
    .map((k) => renderAddressRow(c, k, locked))
    .join('\n      ');

  return `
        <div id="cust-pin-sentinel" class="cust-pin-sentinel" aria-hidden="true"></div>
        <div class="card cust-pin" id="cust-pin">
          <div class="cust-pin-ident">
            <div class="cust-pin-avatar">${esc(initials)}</div>
            <div style="flex:1;min-width:0">
              <div class="cust-pin-name">${esc(c.first)} ${esc(c.last)}</div>
              <div class="cust-pin-meta">${identityMeta(c)}</div>
            </div>
            <div class="cust-pin-actions">${editBtn}</div>
          </div>
          <div class="cust-pin-body">
            ${fields ? `<div class="cust-pin-fields">
        ${fields}
            </div>` : ''}
            ${addressRows ? `<div class="cust-pin-addrs">
      ${addressRows}
            </div>` : ''}
          </div>
        </div>
        <div id="cust-pin-spacer" class="cust-pin-spacer" aria-hidden="true"></div>`;
}

// ─── Sticky / condensed state ────────────────────────────────────────────────
// One observer at a time: renderPage replaces the DOM, so the previous card's
// observer is disconnected before a new one is armed. Heights are measured
// once, up front (toggle the class, read, toggle back) — measuring inside the
// callback would race the browser's own scroll clamping.
let _pinObserver = null;

// Also called by core/router.js when leaving the customers page and by the
// customers list branch: a live observer keeps its (detached) targets — and
// through them the whole old profile subtree — reachable for the tab's life.
export function detachPinObserver() {
  if (_pinObserver) { _pinObserver.disconnect(); _pinObserver = null; }
}

export function attachPinObserver() {
  detachPinObserver();
  if (typeof IntersectionObserver === 'undefined' || typeof getComputedStyle !== 'function') return;
  const card = document.getElementById('cust-pin');
  const sentinel = document.getElementById('cust-pin-sentinel');
  const spacer = document.getElementById('cust-pin-spacer');
  const root = document.querySelector('.page-scroll');
  if (!card || !sentinel || !root) return;
  // Released to static under the narrow / short media query — nothing to do.
  if (getComputedStyle(card).position !== 'sticky') return;

  const full = card.offsetHeight;
  card.classList.add('is-stuck');
  const condensed = card.offsetHeight;
  card.classList.remove('is-stuck');
  const delta = Math.max(0, full - condensed);

  _pinObserver = new IntersectionObserver(([entry]) => {
    const stuck = !entry.isIntersecting;
    card.classList.toggle('is-stuck', stuck);
    if (spacer) spacer.style.height = stuck ? `${delta}px` : '0px';
  }, { root, threshold: 0 });
  _pinObserver.observe(sentinel);
}

// ─── Edit details (two steps) ────────────────────────────────────────────────
// ED carries the typed values across the form → confirm → back hops ONLY:
// `resume` is set by the Back button (and by a server-validation bounce) right
// before re-opening, and every other open starts from the card's values. So
// edits abandoned via Cancel / × / backdrop never resurface pre-filled on the
// next open — a rejected value must not be one click from being saved.
const ED = { custId: null, values: null, resume: false };

// Disable the modal's confirm button for the duration of a request so a
// double-click can't fire the call twice (and close a different modal on the
// second return). Same idea as new-ticket.js's setBusy.
function setConfirmBusy(busy) {
  const btn = document.querySelector('#modal-container [data-action="modal.confirm"]');
  if (btn) btn.disabled = Boolean(busy);
}

function editableFields() {
  return getLayoutFields('customer').filter((f) => Object.hasOwn(EDITABLE, f.key) && (f.headerOwned || isFieldVisible('customer', f.key)));
}

function inputFor(c, f) {
  const def = EDITABLE[f.key];
  const pending = ED.values && Object.hasOwn(ED.values, f.key) ? ED.values[f.key] : undefined;
  const cur = currentValue(c, f.key);
  const val = pending !== undefined ? pending : cur;
  const id = `ed-${f.key}`;
  // Coming back from the confirm step, a pending edit is already "dirty" —
  // paint the green edge up front rather than waiting for the next keystroke.
  const dirty = pending !== undefined && pending !== cur ? ' is-changed' : '';
  const common = `id="${id}" class="form-input${dirty}" data-key="${attr(f.key)}" data-orig="${attr(fmtValue(f.key, cur))}" data-input-action="cust.editDirty"`;
  if (def.type === 'bool') {
    return `<select ${common}>
        <option value="yes"${val ? ' selected' : ''}>Yes</option>
        <option value="no"${!val ? ' selected' : ''}>No</option>
      </select>`;
  }
  if (def.type === 'select') {
    const opts = [...def.options];
    if (val && !opts.includes(val)) opts.unshift(val);   // keep an off-list tier editable, never silently drop it
    return `<select ${common}>
        <option value=""${!val ? ' selected' : ''}>—</option>
        ${opts.map((o) => `<option value="${attr(o)}"${val === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}
      </select>`;
  }
  const type = def.type === 'date' ? 'date' : def.type === 'url' ? 'url' : 'text';
  return `<input type="${type}" ${common} value="${attr(val || '')}"${def.placeholder ? ` placeholder="${attr(def.placeholder)}"` : ''}${def.mono ? ' style="font-family:var(--font-mono)"' : ''}${f.required ? ' required' : ''}/>`;
}

function readForm(fields) {
  const values = {};
  for (const f of fields) {
    const el = document.getElementById(`ed-${f.key}`);
    if (!el) continue;
    if (EDITABLE[f.key].type === 'bool') values[f.key] = el.value === 'yes';
    else values[f.key] = el.value.trim() || null;
  }
  return values;
}

export function showEditDetailsModal(custId) {
  const c = CUSTOMERS.find((x) => x.id === custId);
  if (!c || c.mergedInto || c.erased) return;
  if (!ED.resume || ED.custId !== custId) ED.values = null;
  ED.resume = false;
  ED.custId = custId;
  const fields = editableFields();

  showModal(`Edit details — ${c.first} ${c.last}`.trim(), `
    <div class="form-grid">
      ${fields.map((f) => `<div class="form-row"><label class="form-label" for="ed-${attr(f.key)}">${esc(f.label)}${f.headerOwned || f.required ? ' *' : ''}</label>${inputFor(c, f)}</div>`).join('\n      ')}
    </div>
    <div id="ed-error" style="color:var(--red);font-size:12px;min-height:16px;margin-top:4px"></div>
    <div style="font-size:11.5px;color:var(--ink3);margin-top:6px">Emails and mobiles are managed on the card itself. You'll see a summary of the changes before anything is saved.</div>
  `, () => {
    const values = readForm(fields);
    ED.values = values;
    const changes = {};
    for (const f of fields) {
      const from = currentValue(c, f.key);
      const to = values[f.key];
      if (to !== from) changes[f.key] = { from, to };
    }
    // Only the fields the agent actually changed are validated: a legacy row
    // with no first name can still have its OTHER details fixed. "Required"
    // is the admin's flag from Layouts → Customers (first/last are locked
    // required), which the HTML attribute alone can't enforce — there is no
    // <form> submit here.
    const fail = (key, msg) => {
      document.getElementById('ed-error').textContent = msg;
      document.getElementById(`ed-${key}`)?.focus();
    };
    for (const f of fields) {
      if ((f.required || f.headerOwned) && changes[f.key] && changes[f.key].to == null) {
        return fail(f.key, `${f.label} can't be blank.`);
      }
    }
    // Same http(s) rule the server and the card's link renderer apply — catch
    // the common "pasted without the scheme" case before the round-trip.
    const bo = changes.backoffice_url?.to;
    if (bo && !/^https?:\/\//i.test(bo)) return fail('backoffice_url', 'Backoffice link must start with http:// or https://.');
    if (!Object.keys(changes).length) {
      ED.values = null;
      closeModal();
      showToast('No changes to save', 'info');
      return;
    }
    showConfirmChanges(c, changes);
  }, 'Save');
}

function showConfirmChanges(c, changes) {
  const keys = Object.keys(changes);
  const n = keys.length;
  showModal('Save these changes?', `
    <div style="font-size:12.5px;color:var(--ink2);margin-bottom:6px">You're about to change ${n} detail${n === 1 ? '' : 's'} on <b>${esc(c.first)} ${esc(c.last)} (${esc(c.id)})</b>. Every agent sees the new values immediately, and the change is written to the audit trail.</div>
    ${keys.map((k) => `<div class="ed-changes"><span class="ed-lbl">${esc(EDITABLE[k].label)}</span><span><span class="ed-from">${esc(fmtValue(k, changes[k].from))}</span> → <span class="ed-to">${esc(fmtValue(k, changes[k].to))}</span></span></div>`).join('')}
    <div style="margin-top:12px"><button type="button" class="btn btn-sm" data-action="cust.editBack">← Back to the form</button></div>
  `, () => { saveDetails(c, changes); }, 'Save changes');
}

async function saveDetails(c, changes) {
  const body = {};
  for (const [k, ch] of Object.entries(changes)) body[EDITABLE[k].col] = ch.to;

  if (c._uuid) {
    let res;
    setConfirmBusy(true);
    try {
      res = await apiPatch(`/api/v1/customers/${c._uuid}`, body);
    } catch (err) {
      setConfirmBusy(false);
      // A validation 400 names the field: bounce back to the form (edits
      // intact) and say which one, instead of a bare "Invalid body" toast.
      const issue = err?.status === 400 ? err?.body?.issues?.[0] : null;
      if (issue) {
        const key = Object.keys(EDITABLE).find((k) => EDITABLE[k].col === issue.path?.[0]);
        ED.resume = true;
        showEditDetailsModal(c.id);
        const el = document.getElementById('ed-error');
        if (el) el.textContent = `${key ? EDITABLE[key].label : 'Details'}: ${issue.message || 'invalid value'}`;
        if (key) document.getElementById(`ed-${key}`)?.focus();
        return;
      }
      showToast(`Couldn't save: ${err?.message || err}`, 'error');
      return;   // confirm step stays open — Back returns to the form with the edits intact
    }
    if (res?.customer) applyCustomerRow(c, res.customer);
  } else {
    // Demo persona: assign locally. A field the agent just typed must not be
    // blanked by a later in-memory unmerge, so it leaves the backfill journal.
    for (const [k, ch] of Object.entries(changes)) {
      const vm = vmKey(k);
      c[vm] = k === 'consent' ? Boolean(ch.to) : (ch.to ?? '');
      for (const back of Object.values(c._mergeBackfilled || {})) {
        if (Array.isArray(back.fields)) back.fields = back.fields.filter((f) => f !== vm);
      }
    }
  }
  ED.custId = null; ED.values = null; ED.resume = false;
  closeModal();
  renderPage('customers');
  showToast('Details saved', 'success');
}

// ─── Addresses: add / remove / make primary ──────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let _demoSeq = 0;

// Demo rows may hold only the scalars — materialise the array (with ids) so
// the pills' controls can address rows, then keep the mirror in step.
function demoList(c, kind) {
  const key = kind === 'email' ? 'emails' : 'mobiles';
  if (!Array.isArray(c[key]) || !c[key].length) c[key] = contactArrays(c)[key].map((x) => ({ ...x }));
  for (const x of c[key]) if (!x.id) x.id = `demo-${kind}-${++_demoSeq}`;
  return c[key];
}
function demoMirror(c, kind) {
  const list = c[kind === 'email' ? 'emails' : 'mobiles'] || [];
  const p = list.find((x) => x.is_primary);
  c[kind] = p ? p.value : '';
}
function findDemo(list, ds) {
  return list.find((x) => (ds.contactId && x.id === ds.contactId) || x.value === ds.value);
}

function contactsUrl(c) { return `/api/v1/customers/${c._uuid}/contacts`; }

function showAddContactModal(custId, kind) {
  const c = CUSTOMERS.find((x) => x.id === custId);
  if (!c || c.mergedInto || c.erased) return;
  const noun = kind === 'email' ? 'email' : 'mobile';
  showModal(`Add ${noun} — ${c.first} ${c.last}`.trim(), `
    <div class="form-row"><label class="form-label" for="ac-value">${kind === 'email' ? 'Email address' : 'Mobile number'}</label>
      <input class="form-input" id="ac-value" type="${kind === 'email' ? 'email' : 'tel'}" autocomplete="off" placeholder="${kind === 'email' ? 'name@example.com' : '+44 7700 900000'}"/></div>
    <label style="display:flex;gap:8px;align-items:center;font-size:12.5px;cursor:pointer"><input type="checkbox" id="ac-primary"/> Make this the primary ${noun}</label>
    <div id="ac-error" style="color:var(--red);font-size:12px;min-height:16px;margin-top:6px"></div>
    <div style="font-size:11.5px;color:var(--ink3);margin-top:2px">Replies go to the address the customer's message arrived on, then to the primary.</div>
  `, async () => {
    const value = document.getElementById('ac-value').value.trim();
    const primary = document.getElementById('ac-primary').checked;
    const errEl = document.getElementById('ac-error');
    if (!value) { errEl.textContent = 'Enter a value.'; return; }
    if (kind === 'email' && !EMAIL_RE.test(value)) { errEl.textContent = 'That doesn\'t look like an email address.'; return; }

    if (c._uuid) {
      let res;
      setConfirmBusy(true);
      try {
        res = await apiPost(contactsUrl(c), { kind, value, primary });
      } catch (err) {
        // 409s name the conflict (same profile, or another profile — a merge
        // candidate, not a typo); surface the server's wording as-is.
        setConfirmBusy(false);
        errEl.textContent = err?.message || 'Couldn\'t add the address.';
        return;
      }
      applyContacts(c, res.contacts);
    } else {
      const list = demoList(c, kind);
      if (list.some((x) => x.value.toLowerCase() === value.toLowerCase())) { errEl.textContent = 'This address is already on the profile.'; return; }
      const makePrimary = primary || !list.some((x) => x.is_primary);
      if (makePrimary) list.forEach((x) => { x.is_primary = false; });
      list.push({ id: `demo-${kind}-${++_demoSeq}`, value: kind === 'email' ? value.toLowerCase() : value, is_primary: makePrimary, bounce_state: 'none', bounce_count: 0 });
      demoMirror(c, kind);
    }
    closeModal();
    renderPage('customers');
    showToast(`${kind === 'email' ? 'Email' : 'Mobile'} added`, 'success');
  }, 'Add');
  document.getElementById('ac-value')?.focus();
}

function confirmRemoveContact(ds) {
  const c = CUSTOMERS.find((x) => x.id === ds.custId);
  if (!c || c.mergedInto || c.erased) return;
  const kind = ds.kind === 'mobile' ? 'mobile' : 'email';
  const noun = kind === 'email' ? 'email' : 'mobile number';
  showDangerConfirm({
    title: `Remove this ${noun}?`,
    bodyHtml: `<div style="font-size:12.5px;color:var(--ink2)"><b>${esc(ds.value)}</b> will no longer match this customer.${kind === 'email' ? ' New messages from it would open a fresh profile instead of landing here.' : ''} Past tickets are unaffected.</div>`,
    confirmLabel: 'Remove',
    onConfirm: async () => {
      if (c._uuid) {
        let res;
        setConfirmBusy(true);
        try {
          res = await apiDelete(`${contactsUrl(c)}/${encodeURIComponent(ds.contactId)}`);
        } catch (err) {
          closeModal();
          showToast(err?.message || 'Couldn\'t remove the address.', 'error');
          return;
        }
        applyContacts(c, res.contacts);
      } else {
        const list = demoList(c, kind);
        const target = findDemo(list, ds);
        if (!target) { closeModal(); return; }
        if (kind === 'email' && list.length === 1) { closeModal(); showToast('A customer must keep at least one email address', 'error'); return; }
        if (target.is_primary && list.length > 1) { closeModal(); showToast('Make another address primary first', 'error'); return; }
        list.splice(list.indexOf(target), 1);
        demoMirror(c, kind);
      }
      closeModal();
      renderPage('customers');
      showToast(`${kind === 'email' ? 'Email' : 'Mobile'} removed`, 'success');
    },
  });
}

async function setPrimaryContact(ds) {
  const c = CUSTOMERS.find((x) => x.id === ds.custId);
  if (!c || c.mergedInto || c.erased) return;
  const kind = ds.kind === 'mobile' ? 'mobile' : 'email';
  if (c._uuid) {
    let res;
    try {
      res = await apiPost(`${contactsUrl(c)}/${encodeURIComponent(ds.contactId)}/primary`);
    } catch (err) {
      showToast(err?.message || 'Couldn\'t change the primary address.', 'error');
      return;
    }
    applyContacts(c, res.contacts);
  } else {
    const list = demoList(c, kind);
    const target = findDemo(list, ds);
    if (!target) return;
    list.forEach((x) => { x.is_primary = x === target; });
    demoMirror(c, kind);
  }
  renderPage('customers');
  showToast(`${ds.value} is now the primary ${kind}`, 'success');
}

// ─── Actions ─────────────────────────────────────────────────────────────────
registerActions({
  'cust.editDetails':       (ds) => showEditDetailsModal(ds.custId),
  // Back from the confirm step: re-opens the form with the typed values (ED)
  // intact. The confirm modal's own Cancel just closes, as everywhere else —
  // and the next open then starts clean (see ED.resume).
  'cust.editBack':          () => { if (ED.custId) { ED.resume = true; showEditDetailsModal(ED.custId); } },
  'cust.addContact':        (ds) => showAddContactModal(ds.custId, ds.kind === 'mobile' ? 'mobile' : 'email'),
  'cust.removeContact':     (ds) => confirmRemoveContact(ds),
  'cust.setPrimaryContact': (ds) => setPrimaryContact(ds),
});

registerInputActions({
  // Green edge on an input whose value differs from what the card shows.
  'cust.editDirty': (ds, el) => {
    const key = el.dataset.key;
    const shown = EDITABLE[key]?.type === 'bool' ? (el.value === 'yes' ? 'Yes' : 'No') : (el.value.trim() || '—');
    el.classList.toggle('is-changed', shown !== el.dataset.orig);
  },
});
