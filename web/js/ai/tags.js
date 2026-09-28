import { TICKETS } from '../core/data.js';
import { CURRENT_TICKET } from '../core/state.js';
import { apiPost, getJwt, getWorkspaceId } from '../core/api-client.js';

export function renderAITags(t) {
  const pending = (t.aiTags || []).filter(x => !x.accepted);
  const state = t.aiTagGeneration || {};
  const id = window.escAttr(t.id);
  return `<div class="ts-heading">AI Tag Suggestions</div>
    <div aria-live="polite" aria-atomic="true">
      ${state.error ? `<p role="alert">${window.escHtml(state.error)}</p>` : ''}
      ${pending.length ? `<div class="ai-tag-list">
        ${pending.map(at => `<button type="button" class="ai-tag-chip" data-action="td.acceptAITag" data-ticket-id="${id}" data-tag="${window.escAttr(at.tag)}" aria-label="${window.escAttr('Accept tag ' + at.tag)}"${state.pending ? ' disabled' : ''}>${window.escHtml(at.tag)} <span class="conf">${at.conf}%</span></button>`).join('')}
      </div>` : `<p>${state.done ? 'No new tags to suggest.' : 'No tag suggestions yet.'}</p>`}
      <button type="button" class="btn btn-sm" data-action="td.generateAITags" data-ticket-id="${id}"${state.pending || !t._uuid ? ' disabled' : ''}>${state.pending ? 'Generating tags…' : state.error ? 'Retry' : 'Generate tags'}</button>
      ${pending.length ? `<button type="button" class="btn btn-sm" data-action="td.acceptAllAITags" data-ticket-id="${id}"${state.pending ? ' disabled' : ''}>Accept all</button>` : ''}
      ${!t._uuid ? '<p>Tag generation is available on saved tickets.</p>' : ''}
    </div>`;
}

function refresh(t) {
  const panel = document.getElementById('ticket-ai-tags');
  if (CURRENT_TICKET !== t.id || panel?.dataset.ticketId !== t.id) return;
  const hadFocus = panel.contains?.(document.activeElement);
  panel.innerHTML = renderAITags(t);
  if (hadFocus) {
    panel.tabIndex = -1;
    const target = t.aiTagGeneration?.pending ? panel : panel.querySelector('[data-action="td.generateAITags"]');
    target.focus({ preventScroll: true });
  }
}

export async function generateAITags(ticketId) {
  const t = TICKETS.find(x => x.id === ticketId);
  if (!t?._uuid || t.aiTagGeneration?.pending) return;
  const workspace = getWorkspaceId(), jwt = getJwt();
  const state = { pending: true };
  t.aiTagGeneration = state;
  const active = () => workspace === getWorkspaceId() && jwt === getJwt()
    && TICKETS.find(x => x.id === ticketId) === t && t.aiTagGeneration === state;
  refresh(t);
  try {
    const result = await apiPost(`/api/v1/tickets/${t._uuid}/triage/tags`, {});
    if (!active()) return;
    t.aiTags = result.ai_tags.map(x => ({ tag: x.tag, conf: x.confidence, accepted: x.accepted }));
    state.done = true;
  } catch (err) {
    if (!active()) return;
    state.error = err.status === 402 ? 'This workspace has no AI credit. Ask a platform administrator to add credit, then retry.'
      : err.status === 429 ? 'Too many requests. Wait a minute, then retry.'
      : err.status === 401 ? 'Your session has expired. Sign in again to generate tags.'
      : err.status === 404 ? 'This ticket is no longer available.'
      : err.status === 0 ? 'Could not reach the server. Check your connection, then retry.'
      : 'Tags could not be generated. Please retry.';
  } finally {
    state.pending = false;
    if (active()) refresh(t);
  }
}
