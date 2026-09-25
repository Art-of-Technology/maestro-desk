import { SESSION } from './state.js';
import { showModal, closeModal } from './modal.js';
import { apiGet, getJwt, getWorkspaceId } from './api-client.js';
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

export function recordDemoNoteRevision(note, before, after, beforeHtml = null) {
  (note.revisions ||= []).unshift({ before_text: before, after_text: after, before_html: beforeHtml,
    editor_label: SESSION?.name || 'Unknown', created_at: new Date().toISOString() });
}

export async function showNoteHistory(url, demoRevisions = []) {
  if (!window.isAdmin()) return;
  const workspace = getWorkspaceId(), jwt = getJwt();
  showModal('Note edit history', '<div id="note-history" role="status">Loading history…</div>', null, null, true);
  const host = document.getElementById('note-history');
  try {
    // ponytail: loads all revisions; paginate if long histories become slow.
    const revisions = url ? (await apiGet(url)).revisions : demoRevisions;
    if (workspace !== getWorkspaceId() || jwt !== getJwt() || !window.isAdmin() || !host.isConnected) return;
    host.innerHTML = revisions.length ? revisions.map(r => `
      <details open style="margin-bottom:16px">
        <summary>${window.escHtml(r.editor_label)} · ${window.escHtml(new Date(r.created_at).toLocaleString())}</summary>
        <strong>Before</strong><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${window.escHtml(r.before_text)}</pre>
        <strong>After</strong><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${window.escHtml(r.after_text)}</pre>
      </details>`).join('') : 'No recorded edits. History is available for edits made after revision tracking was enabled.';
  } catch (err) {
    if (host.isConnected && workspace === getWorkspaceId() && jwt === getJwt()) host.textContent = err?.message || 'Could not load note history. Close this window and try again.';
  }
}
