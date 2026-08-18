// ─── Modal helpers ─────────────────────────────────────────────────────────────
// Singleton modal renderer. Every modal in the app — confirm dialogs, forms,
// pickers — paints into the #modal-container <div> and is dismissed by either
// the × button, a background click, or an explicit closeModal() call.
//
// The optional onConfirm callback is held in a module-local (_onConfirm) and
// invoked by the modal.confirm delegated action — no longer serialised via
// onConfirm.toString() into an inline onclick. Callbacks may now use closures
// freely (existing callers read form values from the DOM by id, so behaviour
// is unchanged). A failed-validation callback can return early without
// closing — the modal stays open and Confirm can be clicked again, since
// _onConfirm is only cleared by closeModal().
//
// The close/confirm buttons + backdrop use data-action delegation
// (core/event-delegation.js); the modal box itself carries the data-action=""
// absorber so a click inside the dialog doesn't bubble to the backdrop's close.

import { registerActions, registerInputActions } from './event-delegation.js';

let _onConfirm = null;

// `title` and `confirmLabel` are always PLAIN TEXT — escape them here so no
// caller can inject markup through a modal title (customer/tag/brand names etc.
// flow in). `body` is intentional caller-built HTML and is NOT escaped here;
// callers are responsible for escaping user data inside the body.
// Reached via the window bridge (like every other core module) — showModal only
// runs at interaction time, long after app.js wires up window.escHtml.
export function showModal(title, body, onConfirm, confirmLabel='Save', isLarge=false) {
  _onConfirm = onConfirm || null;
  document.getElementById('modal-container').innerHTML = `
    <div class="modal-bg" data-action="modal.close">
      <div class="${isLarge?'modal modal-lg':'modal'}" data-action="">
        <div class="modal-head">
          <div class="modal-title">${window.escHtml(title)}</div>
          <div class="modal-close" data-action="modal.close">×</div>
        </div>
        <div class="modal-body">${body}</div>
        ${onConfirm?`<div class="modal-foot">
          <button class="btn" data-action="modal.close">Cancel</button>
          <button class="btn btn-solid" data-action="modal.confirm">${window.escHtml(confirmLabel)}</button>
        </div>`:''}
      </div>
    </div>`;
}

export function closeModal() {
  _onConfirm = null;
  _dangerExpected = null;
  document.getElementById('modal-container').innerHTML = '';
}

// ─── Danger confirmation ─────────────────────────────────────────────────────
// showModal dressed for destructive actions: red confirm button and an
// optional type-to-confirm input (the god-panel suspend recipe, lifted here
// so every delete/merge surface shares one implementation). Contract is
// showModal's — `bodyHtml` is caller-built HTML (escape your own
// interpolations) and `onConfirm` owns closeModal(). Only one modal exists
// at a time, so opening this from inside another modal replaces it.
let _dangerExpected = null;

export function showDangerConfirm({ title, bodyHtml, confirmLabel = 'Delete', typeToConfirm = null, onConfirm }) {
  _dangerExpected = typeToConfirm ? String(typeToConfirm) : null;
  const inputRow = _dangerExpected ? `
    <div style="font-size:12px;color:var(--ink2);margin:14px 0 6px">Type <code>${window.escHtml(_dangerExpected)}</code> to confirm:</div>
    <input class="form-input" id="danger-confirm-input" data-input-action="modal.dangerInput"
           placeholder="${window.escAttr(_dangerExpected)}" autocomplete="off" autocapitalize="off"
           spellcheck="false" style="width:100%"/>` : '';
  showModal(title, `${bodyHtml}${inputRow}`, () => {
    if (_dangerExpected) {
      const el = document.getElementById('danger-confirm-input');
      // Re-validate inside the callback — the disabled button is cosmetic.
      if (!el || el.value.trim() !== _dangerExpected) return;
    }
    onConfirm();
  }, confirmLabel);
  const btn = document.querySelector('#modal-container [data-action="modal.confirm"]');
  if (btn) {
    btn.classList.remove('btn-solid');
    btn.classList.add('btn-danger');
    if (_dangerExpected) btn.disabled = true;
  }
  if (_dangerExpected) document.getElementById('danger-confirm-input')?.focus();
}

registerActions({
  'modal.close':   () => closeModal(),
  // Invoke the stored callback WITHOUT clearing it or auto-closing: the
  // callback owns dismissal (most call closeModal() on success), and a
  // validation-failure early-return leaves the modal open for a retry.
  'modal.confirm': () => { if (_onConfirm) _onConfirm(); },
});

registerInputActions({
  'modal.dangerInput': (ds, el) => {
    const btn = document.querySelector('#modal-container [data-action="modal.confirm"]');
    if (btn) btn.disabled = el.value.trim() !== _dangerExpected;
  },
});
