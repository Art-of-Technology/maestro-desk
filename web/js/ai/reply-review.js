import { loadDraftReview, saveDraftReview } from '../tickets/drafts.js';

function safeLink(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function renderReplyReview(id, value = loadDraftReview(id), saved = false) {
  if (!value) return '';
  const refs = value.references.filter(r => r && typeof r.title === 'string').slice(0, 20);
  const notes = value.notes.filter(n => typeof n === 'string').slice(0, 10);
  return `<details class="reply-internal-review" ${saved ? '' : 'open'}>
    <summary>Internal references — not sent</summary>
    <p>${saved ? 'Saved with this reply for agents only. These sources and notes accompanied the suggestion; the reply may have been edited before sending.' : 'For agents only. Review these alongside the reply before sending.'}</p>
    ${refs.length ? `<ul>${refs.map(r => {
      const url = safeLink(r.url);
      const title = `${r.id || ''} · ${r.title}`;
      return `<li>${url ? `<a href="${window.escAttr(url)}" target="_blank" rel="noopener noreferrer">${window.escHtml(title)}</a>` : window.escHtml(title)}</li>`;
    }).join('')}</ul>` : '<p>No source references were returned.</p>'}
    ${notes.length ? `<ul>${notes.map(n => `<li>${window.escHtml(n)}</li>`).join('')}</ul>` : ''}
  </details>`;
}

export function showReplyReview(id, value, tab) {
  saveDraftReview(id, value, tab);
  const panel = document.getElementById('reply-review-' + id);
  if (panel) panel.innerHTML = renderReplyReview(id, value);
}
