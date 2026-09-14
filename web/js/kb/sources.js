import {
  apiGet,
  apiPost,
  apiDelete,
  apiCall,
  getWorkspaceId,
  getJwt,
} from '../core/api-client.js';
import { showModal, closeModal, showDangerConfirm } from '../core/modal.js';
import { registerActions } from '../core/event-delegation.js';
import { showToast } from '../core/toast.js';
import { loadWorkspaceData } from '../core/bootstrap.js';
import { renderPage } from '../core/router.js';
import { attachKnowledgeFilePicker, knowledgeFilePickerHtml } from './file-picker.js';

const esc = (value) => window.escHtml(String(value ?? ''));
const attr = (value) => window.escAttr(String(value ?? ''));
const date = (value) => (value ? new Date(value).toLocaleString() : 'Not processed yet');
const scope = () => `${getJwt()}:${getWorkspaceId()}`;
let busy = false;
async function perform(fn) {
  if (busy) return;
  busy = true;
  try {
    await fn();
  } catch (e) {
    showToast(e?.message || 'Could not complete the request.', 'error');
  } finally {
    busy = false;
  }
}
function fields() {
  return `<p>Upload a PDF, Word document, PowerPoint or image. Review the extracted text before publishing.</p>
    <div class="form-row"><label for="ks-title" class="form-label">Article title</label><input id="ks-title" class="form-input" maxlength="300" required></div>
    <div class="form-row"><label for="ks-category" class="form-label">Category</label><input id="ks-category" class="form-input" value="Withdrawals" maxlength="100"></div>
    <div class="form-row"><label for="ks-language" class="form-label">Language code</label><input id="ks-language" class="form-input" value="en" placeholder="en or es-MX"></div>
    <div class="form-row"><label for="ks-region" class="form-label">Jurisdiction</label><input id="ks-region" class="form-input" maxlength="100" placeholder="For example, Mexico"></div>
    ${knowledgeFilePickerHtml()}
    <p id="ks-progress" role="status"></p>`;
}
function newSource(source = null) {
  if (!getJwt() || !getWorkspaceId()) {
    showToast('Sign in to import knowledge.', 'warn');
    return;
  }
  const started = scope();
  let picker;
  let confirm;
  showModal(
    source ? `Replace file: ${source.title}` : 'Upload knowledge file',
    source
      ? `<p>Choose an updated file for this article. Its title, category, language and history will stay the same. Review the new text before publishing.</p>
        <p class="ks-current-file">Current file: <strong>${esc(source.locator)}</strong></p>
        ${knowledgeFilePickerHtml()}<p id="ks-progress" role="status"></p>`
      : fields(),
    () =>
      perform(async () => {
        if (started !== scope() || !picker.isActive()) return;
        const value = (id) => document.getElementById(id)?.value?.trim() || '';
        const input = {
          title: value('ks-title'),
          category: value('ks-category'),
          language: value('ks-language'),
          jurisdiction: value('ks-region'),
        };
        if (!source && (!input.title || !input.category || !input.language)) {
          showToast('Add a title, category and language.', 'warn');
          return;
        }
        const file = picker.getFile();
        if (!file) return;
        const progress = document.getElementById('ks-progress');
        if (progress) progress.textContent = 'Importing… This can take up to 90 seconds.';
        picker.setBusy(true);
        if (confirm) confirm.disabled = true;
        let result;
        try {
          const form = new FormData();
          if (!source) for (const [key, value] of Object.entries(input)) form.set(key, value);
          form.set('file', file);
          result = await apiCall(source ? `/api/v1/knowledge-sources/${source.id}/replace` : '/api/v1/knowledge-sources', { method: 'POST', form });
        } finally {
          if (progress) progress.textContent = '';
          picker.setBusy(false);
          if (confirm) confirm.disabled = false;
        }
        if (started !== scope() || !progress?.isConnected) return;
        if (result.duplicate) showToast(source ? 'This file is already current. Opening its review.' : 'This source already exists. Opening its review.', 'info');
        await reviewSource(result.source.id);
      }),
    'Import for review',
    true,
  );
  const root = document.getElementById('ks-picker');
  picker = attachKnowledgeFilePicker(root);
  const dialog = root.closest('.modal');
  dialog.classList.add('ks-upload-modal');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', source ? `Replace file: ${source.title}` : 'Upload knowledge file');
  confirm = dialog.querySelector('[data-action="modal.confirm"]');
  (document.getElementById('ks-title') || dialog.querySelector('[data-action="ks.choose"]'))?.focus();
}
export async function openKnowledgeSources() {
  const started = scope();
  const { sources } = await apiGet('/api/v1/knowledge-sources');
  if (started !== scope()) return;
  showModal(
    'Uploaded files',
    `<p>Use Replace file when your content changes, or upload a file for a new article. Published articles stay available while you review.</p>
    <button class="btn btn-sm" data-action="ks.file">Upload file</button>
    ${
      sources
        .filter((s) => s.kind === 'file')
        .map(
          (
            s,
          ) => `<section style="padding:16px 0;border-bottom:1px solid var(--rule)"><h3>${esc(s.title)}</h3>
      <p style="overflow-wrap:anywhere">${esc(s.locator)} · ${esc(s.language)} · ${esc(s.jurisdiction || 'Jurisdiction not specified')}</p>
      <p>${s.error ? 'Processing failed' : s.latest_version_id ? (s.needs_review ? 'Ready for review' : 'Published') : 'Awaiting import'} · Last processed: ${esc(date(s.checked_at))}</p>
      ${s.error ? `<p role="status">${esc(s.error)}</p>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-sm" data-action="ks.review" data-id="${attr(s.id)}">Review & history</button>
      <button class="btn btn-sm" data-action="ks.replace" data-id="${attr(s.id)}">Replace file</button>
      <button class="btn btn-sm" data-action="ks.refresh" data-id="${attr(s.id)}">Reprocess file</button>
      <button class="btn btn-sm" data-action="ks.remove" data-id="${attr(s.id)}">Remove</button></div></section>`,
        )
        .join('') || '<p>No files yet. Upload a file to get started.</p>'
    }`,
    null,
    '',
    true,
  );
}
async function reviewSource(id, versionId) {
  const started = scope();
  const { source: s, versions } = await apiGet(`/api/v1/knowledge-sources/${id}`);
  if (started !== scope()) return;
  if (s.kind !== 'file') {
    showToast('Uploaded file not found.', 'error');
    return;
  }
  const v = versions.find((v) => v.id === (versionId || s.latest_version_id)) || versions[0];
  const approved = versions.find((v) => v.id === s.approved_version_id);
  showModal(
    `Review: ${s.title}`,
    `<p>${esc(s.language)} · ${esc(s.jurisdiction || 'Jurisdiction not specified')} · Last processed: ${esc(date(s.checked_at))}</p>
    ${s.error ? `<p role="status">${esc(s.error)}</p>` : ''}
    <button class="btn btn-sm" data-action="ks.download" data-id="${attr(id)}">Download original</button>
    <button class="btn btn-sm" data-action="ks.replace" data-id="${attr(id)}">Replace file</button>
    ${
      v
        ? `<p>${v.id === s.approved_version_id ? 'This version is published.' : 'Review this version before publishing. Publishing replaces this source’s article.'}</p>
      ${(v.warnings || []).map((w) => `<p>${esc(w)}</p>`).join('')}
      <label class="form-label" for="ks-extracted">Extracted content · ${esc(date(v.created_at))}</label>
      <textarea id="ks-extracted" class="form-input" readonly style="height:280px">${esc(v.body)}</textarea>
      ${approved && approved.id !== v.id ? `<details><summary>Compare with published version</summary><pre style="white-space:pre-wrap;max-height:250px;overflow:auto">${esc(approved.body)}</pre></details>` : ''}
      <h3>Version history</h3>${versions.map((item) => `<button class="btn btn-sm" data-action="ks.review" data-id="${attr(id)}" data-version="${attr(item.id)}">${esc(date(item.created_at))}${item.id === s.approved_version_id ? ' · published' : ''}</button>`).join('')}`
        : '<p>No extracted content is available. Try reprocessing the file or upload another file.</p>'
    }`,
    v
      ? () =>
          perform(async () => {
            if (started !== scope()) return;
            await apiPost(`/api/v1/knowledge-sources/${id}/publish`, { version_id: v.id });
            if (started !== scope()) return;
            closeModal();
            await loadWorkspaceData();
            renderPage('kb');
            showToast('Article published.', 'success');
          })
      : null,
    v?.id === s.approved_version_id ? 'Keep published' : 'Publish this version',
    true,
  );
}
registerActions({
  'ks.open': () => perform(openKnowledgeSources),
  'ks.file': () => newSource(),
  'ks.choose': () => document.getElementById('ks-file')?.click(),
  'ks.replace': (ds) => perform(async () => {
    const started = scope();
    const { source } = await apiGet(`/api/v1/knowledge-sources/${ds.id}`);
    if (started !== scope()) return;
    if (source.kind !== 'file') throw new Error('Uploaded file not found.');
    newSource(source);
  }),
  'ks.review': (ds) => perform(() => reviewSource(ds.id, ds.version)),
  'ks.refresh': (ds) =>
    perform(async () => {
      const started = scope();
      showToast('Processing file…', 'info');
      await apiPost(`/api/v1/knowledge-sources/${ds.id}/refresh`, {});
      if (started === scope()) await openKnowledgeSources();
    }),
  'ks.download': (ds) =>
    perform(async () => {
      const started = scope();
      const { url } = await apiGet(`/api/v1/knowledge-sources/${ds.id}/download`);
      if (started === scope())
        showModal(
          'Download original',
          `<p><a class="btn btn-sm" href="${attr(url)}" target="_blank" rel="noopener noreferrer">Download file</a></p><p>This private download link expires in five minutes.</p>`,
          null,
          '',
        );
    }),
  'ks.remove': (ds) => {
    const started = scope();
    showDangerConfirm({
      title: 'Remove knowledge source?',
      bodyHtml:
        '<p>This removes the source, its versions and its published article. The original file will be scheduled for deletion.</p>',
      onConfirm: () =>
        perform(async () => {
          if (started !== scope()) return;
          await apiDelete(`/api/v1/knowledge-sources/${ds.id}`);
          if (started !== scope()) return;
          closeModal();
          await loadWorkspaceData();
          renderPage('kb');
        }),
    });
  },
});
