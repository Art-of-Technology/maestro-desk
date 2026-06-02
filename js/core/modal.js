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

import { registerActions } from './event-delegation.js';

let _onConfirm = null;

export function showModal(title, body, onConfirm, confirmLabel='Save', isLarge=false) {
  _onConfirm = onConfirm || null;
  document.getElementById('modal-container').innerHTML = `
    <div class="modal-bg" data-action="modal.close">
      <div class="${isLarge?'modal modal-lg':'modal'}" data-action="">
        <div class="modal-head">
          <div class="modal-title">${title}</div>
          <div class="modal-close" data-action="modal.close">×</div>
        </div>
        <div class="modal-body">${body}</div>
        ${onConfirm?`<div class="modal-foot">
          <button class="btn" data-action="modal.close">Cancel</button>
          <button class="btn btn-solid" data-action="modal.confirm">${confirmLabel}</button>
        </div>`:''}
      </div>
    </div>`;
}

export function closeModal() {
  _onConfirm = null;
  document.getElementById('modal-container').innerHTML = '';
}

registerActions({
  'modal.close':   () => closeModal(),
  // Invoke the stored callback WITHOUT clearing it or auto-closing: the
  // callback owns dismissal (most call closeModal() on success), and a
  // validation-failure early-return leaves the modal open for a retry.
  'modal.confirm': () => { if (_onConfirm) _onConfirm(); },
});
