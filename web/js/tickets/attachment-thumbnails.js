import { apiGet, getWorkspaceId, getJwt } from '../core/api-client.js';

const imageTypes = new Set(['image/png','image/jpeg','image/webp','image/gif']);
let scope = null, observer = null;
const files = new Map(), targets = new Set();

export function attachmentBadge(file, ticketUuid) {
  const isImage = imageTypes.has(file.mime_type);
  const extension = String(file.filename || '').match(/\.([a-z0-9]{1,5})$/i)?.[1];
  const label = isImage ? 'IMG' : file.mime_type === 'application/pdf' ? 'PDF'
    : extension ? extension.toUpperCase() : 'FILE';
  return `<span class="att-file-badge" aria-hidden="true"${isImage && ticketUuid ? ` data-image-thumb="${window.escAttr(file.id)}"` : ''}>${window.escHtml(label)}</span>`;
}

export function resetAttachmentThumbnails() {
  observer?.disconnect(); observer = null; scope = null;
  for (const file of files.values()) { file.controller.abort(); if (file.url) URL.revokeObjectURL(file.url); }
  for (const target of targets) if (target.isConnected) target.textContent = 'IMG';
  files.clear(); targets.clear();
}

function scopeIsCurrent(captured) {
  return scope === captured && captured.workspace === getWorkspaceId() && captured.jwt === getJwt();
}

async function loadThumbnail(target) {
  const captured = scope, id = target.dataset.imageThumb;
  if (!captured || !scopeIsCurrent(captured) || !target.isConnected) return;
  let file = files.get(id);
  if (!file) {
    file = { controller: new AbortController(), url: null };
    files.set(id, file);
    // ponytail: originals are fetched once per open ticket; add server resizing if large-image traffic warrants it.
    file.ready = apiGet(`/api/v1/tickets/${encodeURIComponent(captured.ticket)}/attachments/${encodeURIComponent(id)}/content`,
      { blob: true, signal: file.controller.signal }).then(blob => {
      if (!scopeIsCurrent(captured) || !imageTypes.has(blob.type)) return null;
      file.url = URL.createObjectURL(blob);
      return file.url;
    }).catch(() => null);
  }
  const url = await file.ready;
  if (!scopeIsCurrent(captured) || !target.isConnected || !targets.has(target)) return;
  if (!url) { target.title = 'Thumbnail unavailable. Select the attachment to preview or download it.'; return; }
  const img = document.createElement('img');
  img.alt = ''; img.width = 40; img.height = 40; img.decoding = 'async';
  img.addEventListener('error', () => { if (img.parentNode === target) target.textContent = 'IMG'; });
  img.src = url; target.replaceChildren(img);
}

export function mountAttachmentThumbnails(root, ticketUuid) {
  if (!root?.querySelectorAll || typeof IntersectionObserver === 'undefined') return;
  const workspace = getWorkspaceId(), jwt = getJwt();
  if (!ticketUuid || !workspace || !jwt) { resetAttachmentThumbnails(); return; }
  if (!scope || scope.ticket !== ticketUuid || scope.workspace !== workspace || scope.jwt !== jwt) {
    resetAttachmentThumbnails(); scope = { ticket: ticketUuid, workspace, jwt };
  }
  observer?.disconnect(); targets.clear();
  observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting && targets.has(entry.target)) {
      observer.unobserve(entry.target); void loadThumbnail(entry.target);
    }
  });
  for (const target of root.querySelectorAll('[data-image-thumb]')) {
    targets.add(target); observer.observe(target);
  }
}

window.addEventListener?.('respovia:auth-scope-changed', resetAttachmentThumbnails);
