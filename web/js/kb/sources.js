import {
  apiGet,
  apiPost,
  apiPatch,
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

const esc = (value) => window.escHtml(String(value ?? ''));
const attr = (value) => window.escAttr(String(value ?? ''));
const date = (value) => (value ? new Date(value).toLocaleString() : 'Not checked yet');
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
function fields(kind) {
  return `<p>${kind === 'url' ? 'Import one public page. Changes are checked hourly and held for review before updating the published article.' : 'Upload a PDF, Word document, PowerPoint or image. Review the extracted text before publishing.'}</p>
    <div class="form-row"><label for="ks-title" class="form-label">Article title</label><input id="ks-title" class="form-input" maxlength="300" required></div>
    <div class="form-row"><label for="ks-category" class="form-label">Category</label><input id="ks-category" class="form-input" value="Withdrawals" maxlength="100"></div>
    <div class="form-row"><label for="ks-language" class="form-label">Language code</label><input id="ks-language" class="form-input" value="en" placeholder="en or es-MX"></div>
    <div class="form-row"><label for="ks-region" class="form-label">Jurisdiction</label><input id="ks-region" class="form-input" maxlength="100" placeholder="For example, Mexico"></div>
    ${
      kind === 'url'
        ? '<div class="form-row"><label for="ks-url" class="form-label">Public page URL</label><input id="ks-url" class="form-input" type="url" placeholder="https://…"></div>'
        : '<div class="form-row"><label for="ks-file" class="form-label">File</label><input id="ks-file" type="file" accept=".pdf,.docx,.pptx,.png,.jpg,.jpeg,.webp"><p>Up to 20 MB and 30 PDF pages or slides. OCR supports English and Spanish. Convert older .doc and .ppt files first.</p></div>'
    }
    <p id="ks-progress" role="status"></p>`;
}
function newSource(kind) {
  if (!getJwt() || !getWorkspaceId()) {
    showToast('Sign in to import knowledge.', 'warn');
    return;
  }
  const started = scope();
  showModal(
    kind === 'url' ? 'Add website page' : 'Upload knowledge file',
    fields(kind),
    () =>
      perform(async () => {
        if (started !== scope()) return;
        const value = (id) => document.getElementById(id)?.value?.trim() || '';
        const input = {
          title: value('ks-title'),
          category: value('ks-category'),
          language: value('ks-language'),
          jurisdiction: value('ks-region'),
        };
        if (!input.title || !input.category || !input.language) {
          showToast('Add a title, category and language.', 'warn');
          return;
        }
        const progress = document.getElementById('ks-progress');
        if (progress) progress.textContent = 'Importing… This can take up to 90 seconds.';
        let result;
        try {
          if (kind === 'url')
            result = await apiPost('/api/v1/knowledge-sources', {
              ...input,
              url: value('ks-url'),
              auto_refresh: true,
            });
          else {
            const file = document.getElementById('ks-file')?.files?.[0];
            if (!file || file.size > 20 * 1024 * 1024)
              throw new Error('Choose a file up to 20 MB.');
            const form = new FormData();
            for (const [key, value] of Object.entries(input)) form.set(key, value);
            form.set('file', file);
            result = await apiCall('/api/v1/knowledge-sources', { method: 'POST', form });
          }
        } finally {
          if (progress) progress.textContent = '';
        }
        if (started !== scope() || !progress?.isConnected) return;
        if (result.duplicate) showToast('This source already exists. Opening its review.', 'info');
        await reviewSource(result.source.id);
      }),
    'Import for review',
    true,
  );
}
export async function openKnowledgeSources() {
  const started = scope();
  const { sources } = await apiGet('/api/v1/knowledge-sources');
  if (started !== scope()) return;
  showModal(
    'Knowledge sources',
    `<p>Published articles stay available while source changes await review. A failed check does not mean the saved content is current.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-sm" data-action="ks.url">Add website page</button><button class="btn btn-sm" data-action="ks.file">Upload file</button></div>
    ${
      sources
        .map(
          (
            s,
          ) => `<section style="padding:16px 0;border-bottom:1px solid var(--rule)"><h3>${esc(s.title)}</h3>
      <p style="overflow-wrap:anywhere">${esc(s.locator)} · ${esc(s.language)} · ${esc(s.jurisdiction || 'Jurisdiction not specified')}</p>
      <p>${s.error ? 'Check failed' : s.latest_version_id ? (s.needs_review ? 'Ready for review' : 'Published') : 'Awaiting import'} · Last successful check: ${esc(date(s.checked_at))}</p>
      ${s.error ? `<p role="status">${esc(s.error)}</p>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-sm" data-action="ks.review" data-id="${attr(s.id)}">Review & history</button>
      <button class="btn btn-sm" data-action="ks.refresh" data-id="${attr(s.id)}">Refresh now</button>
      ${s.kind === 'url' ? `<button class="btn btn-sm" data-action="ks.auto" data-id="${attr(s.id)}" data-enabled="${s.auto_refresh ? 'false' : 'true'}">${s.auto_refresh ? 'Pause hourly checks' : 'Enable hourly checks'}</button>` : ''}
      <button class="btn btn-sm" data-action="ks.remove" data-id="${attr(s.id)}">Remove</button></div></section>`,
        )
        .join('') || '<p>No sources yet. Add a website page or upload a file.</p>'
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
  const v = versions.find((v) => v.id === (versionId || s.latest_version_id)) || versions[0];
  const approved = versions.find((v) => v.id === s.approved_version_id);
  showModal(
    `Review: ${s.title}`,
    `<p>${esc(s.language)} · ${esc(s.jurisdiction || 'Jurisdiction not specified')} · Last successful check: ${esc(date(s.checked_at))}</p>
    ${s.error ? `<p role="status">${esc(s.error)}</p>` : ''}
    ${s.kind === 'file' ? `<button class="btn btn-sm" data-action="ks.download" data-id="${attr(id)}">Download original</button>` : `<a href="${attr(s.locator)}" target="_blank" rel="noopener noreferrer">Open source page</a>`}
    ${
      v
        ? `<p>${v.id === s.approved_version_id ? 'This version is published.' : 'Review this version before publishing. Publishing replaces this source’s article.'}</p>
      ${(v.warnings || []).map((w) => `<p>${esc(w)}</p>`).join('')}
      <label class="form-label" for="ks-extracted">Extracted content · ${esc(date(v.created_at))}</label>
      <textarea id="ks-extracted" class="form-input" readonly style="height:280px">${esc(v.body)}</textarea>
      ${approved && approved.id !== v.id ? `<details><summary>Compare with published version</summary><pre style="white-space:pre-wrap;max-height:250px;overflow:auto">${esc(approved.body)}</pre></details>` : ''}
      <h3>Version history</h3>${versions.map((item) => `<button class="btn btn-sm" data-action="ks.review" data-id="${attr(id)}" data-version="${attr(item.id)}">${esc(date(item.created_at))}${item.id === s.approved_version_id ? ' · published' : ''}</button>`).join('')}`
        : '<p>No extracted content is available. Try Refresh now or upload another file.</p>'
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
  'ks.url': () => newSource('url'),
  'ks.file': () => newSource('file'),
  'ks.review': (ds) => perform(() => reviewSource(ds.id, ds.version)),
  'ks.refresh': (ds) =>
    perform(async () => {
      const started = scope();
      showToast('Checking source…', 'info');
      await apiPost(`/api/v1/knowledge-sources/${ds.id}/refresh`, {});
      if (started === scope()) await openKnowledgeSources();
    }),
  'ks.auto': (ds) =>
    perform(async () => {
      const started = scope();
      await apiPatch(`/api/v1/knowledge-sources/${ds.id}`, { auto_refresh: ds.enabled === 'true' });
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
