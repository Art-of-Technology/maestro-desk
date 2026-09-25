import { showModal, closeModal } from './modal.js';
import { getJwt, getWorkspaceId } from './api-client.js';
import { showToast } from './toast.js';

// Shared by ticket and contact notes. Saving never replaces the surrounding page.
export function showNoteEditor({ text, maxLength, save, onSaved }) {
  if (!window.isAdmin()) return;
  const workspace = getWorkspaceId(), jwt = getJwt();
  let saving = false;
  showModal('Edit note', `
    <div class="form-row"><label class="form-label" for="edit-note-text">Note</label>
      <textarea class="form-input" id="edit-note-text" maxlength="${maxLength}" style="min-height:160px">${window.escHtml(text)}</textarea></div>
    <div id="edit-note-error" role="alert" style="color:var(--red);font-size:12px"></div>
  `, async () => {
    if (saving || !window.isAdmin() || workspace !== getWorkspaceId() || jwt !== getJwt()) return;
    const value = input.value.trim();
    if (!value || value.length > maxLength) { error.textContent = `Enter a note of 1 to ${maxLength} characters.`; return; }
    if (value === text) { closeModal(); return; }
    saving = true; button.disabled = true; error.textContent = '';
    try {
      const saved = await save(value);
      if (workspace !== getWorkspaceId() || jwt !== getJwt()) return;
      onSaved(saved);
      if (document.getElementById('edit-note-text') === input) closeModal();
      showToast('Note updated', 'success');
    } catch (err) {
      if (error.isConnected) error.textContent = err?.message || 'Could not save the note. Try again.';
    } finally {
      saving = false;
      if (button.isConnected) button.disabled = false;
    }
  }, 'Save changes');
  const input = document.getElementById('edit-note-text');
  const error = document.getElementById('edit-note-error');
  const button = document.querySelector('#modal-container [data-action="modal.confirm"]');
  input.focus();
}
