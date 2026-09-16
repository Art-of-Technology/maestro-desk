import { loadDraftReview, saveDraftReview } from '../tickets/drafts.js';
import { renderReplyFeedback } from './reply-feedback.js';
import { getWorkspaceId } from '../core/api-client.js';
import { formatRoute } from '../core/route-location.js';

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
  return `${saved ? '' : renderReplyFeedback(id, value)}<details class="reply-internal-review" ${saved ? '' : 'open'}>
    <summary>Internal references — not sent</summary>
    <p>${saved ? 'Saved with this reply for agents only. These sources and notes accompanied the suggestion; the reply may have been edited before sending.' : 'For agents only. Review these alongside the reply before sending.'}</p>
    ${refs.length ? `<ul>${refs.map(r => {
      const url = safeLink(r.url);
      const title = `${r.id || ''} · ${r.title}`;
      let ticketLink=null;
      if(r.kind==='ticket' && r.entityId){try{ticketLink=formatRoute({workspaceId:getWorkspaceId(),page:'tickets',entityId:r.entityId});}catch{}}
      const sourceTitle=r.kind==='article'?`<button type="button" class="btn btn-sm" data-action="td.openKB" data-kb-id="${window.escAttr(r.id)}">${window.escHtml(title)}</button>`
        :ticketLink?`<a href="${window.escAttr(ticketLink)}" target="_blank" rel="noopener noreferrer">${window.escHtml(title)}</a>`
        :url?`<a href="${window.escAttr(url)}" target="_blank" rel="noopener noreferrer">${window.escHtml(title)}</a>`:window.escHtml(title);
      const date=r.datedAt && Number.isFinite(new Date(r.datedAt).getTime())?new Date(r.datedAt).toISOString().slice(0,10):'Not recorded';
      const warnings=Array.isArray(r.warnings)?r.warnings.filter(w=>typeof w==='string').slice(0,6):[];
      return `<li class="reply-evidence-source">${sourceTitle}
        <p>${r.kind==='ticket'?'Previous reply':r.kind==='article'?'Knowledge article':'Provided source'} · ${r.kind==='ticket'?'Sent':'Updated'}: ${window.escHtml(date)} · Market: ${window.escHtml(r.market||'Not recorded')}${r.language?` · Language: ${window.escHtml(r.language)}`:''}</p>
        ${r.kind==='article' && url?`<a href="${window.escAttr(url)}" target="_blank" rel="noopener noreferrer">Open original source</a>`:''}
        ${warnings.length?`<ul class="reply-evidence-warnings">${warnings.map(w=>`<li>${window.escHtml(w)}</li>`).join('')}</ul>`:''}</li>`;
    }).join('')}</ul>` : '<p class="reply-evidence-warnings">No source references were returned. Verify policy claims before sending.</p>'}
    ${notes.length ? `<ul>${notes.map(n => `<li>${window.escHtml(n)}</li>`).join('')}</ul>` : ''}
  </details>`;
}

export function showReplyReview(id, value, tab) {
  saveDraftReview(id, value, tab);
  const panel = document.getElementById('reply-review-' + id);
  if (panel) panel.innerHTML = renderReplyReview(id, value);
}
