import { apiGet, getWorkspaceId, getJwt } from '../core/api-client.js';
import { registerActions } from '../core/event-delegation.js';
import { FEEDBACK_REASONS } from '../ai/reply-feedback.js';
import { formatRoute } from '../core/route-location.js';

export function settingsReplyFeedback() {
  if (!window.isAdmin()) return '<p>Admin permission is required to review feedback.</p>';
  setTimeout(() => loadReplyFeedback(0), 0);
  return '<h2 class="settings-h">Reply feedback</h2><p>Review suggestions agents marked Not helpful. Ratings help your team spot problems; they don’t automatically change future replies.</p><div id="reply-feedback-list" aria-live="polite"><p>Loading feedback…</p></div>';
}

export async function loadReplyFeedback(offset = 0) {
  const host = document.getElementById('reply-feedback-list');
  if (!host || !window.isAdmin()) return;
  const workspace = getWorkspaceId(), jwt = getJwt();
  const request = String(Number(host.dataset.request || 0) + 1);
  host.dataset.request = request;
  const active = () => host.isConnected && host === document.getElementById('reply-feedback-list')
    && host.dataset.request === request && workspace === getWorkspaceId() && jwt === getJwt() && window.isAdmin();
  const pageButton = (label, page) => `<button type="button" class="btn btn-ghost" data-action="replyFeedback.page" data-offset="${page}">${label}</button>`;
  host.innerHTML = '<p>Loading feedback…</p>';
  try {
    const data = await apiGet(`/api/v1/ai/reply-feedback?offset=${offset}`);
    if (!active()) return;
    const link = t => `<a href="${window.escAttr(formatRoute({workspaceId:workspace,page:'tickets',entityId:t.id}))}">${window.escHtml(t.display_id)} · ${window.escHtml(t.subject)}</a>`;
    host.innerHTML = `<div class="reply-feedback-controls">${pageButton('Refresh', offset)}${offset ? pageButton('Previous', Math.max(0,offset-25)) : ''}${data.hasMore && offset < 10000 ? pageButton('Next',offset+25) : ''}</div>` +
      (data.items.length ? data.items.map(item => `<article class="reply-feedback-card"><h3>${link({id:item.ticket_id,display_id:item.display_id,subject:item.subject})}</h3>
        <p><strong>${FEEDBACK_REASONS[item.reason] || 'No reason given'}</strong> · ${window.escHtml(new Date(item.updated_at).toLocaleString())}</p>
        <p class="reply-feedback-text">${window.escHtml(item.reply)}</p>
        <p>Original suggestion. The agent may have edited it before sending.</p>
        <details><summary>Previous tickets used as examples (${item.sources.length})</summary>${item.sources.length ? `<ul>${item.sources.map(t => `<li>${link(t)}</li>`).join('')}</ul>` : '<p>No previous ticket examples were used.</p>'}</details></article>`).join('')
        : '<p>No suggestions marked Not helpful on this page.</p>');
  } catch {
    if (active()) host.innerHTML = `<p>Feedback couldn’t be loaded. Try again.</p>${pageButton('Try again',offset)}`;
  }
}
registerActions({ 'replyFeedback.page': ds => loadReplyFeedback(Number(ds.offset) || 0) });
