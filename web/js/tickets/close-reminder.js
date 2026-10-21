import { SESSION } from '../core/state.js';
import { getWorkspaceId } from '../core/api-client.js';
import { showToast } from '../core/toast.js';

const fallback = new Set();
// shortcut: reminders belong to this browser and agent; use server storage if cross-device recovery is needed.
function keyFor(t) {
  return `close-reminder:v1:${getWorkspaceId() || 'demo'}:${SESSION?.userId || 'demo'}:${t._uuid || t.id}`;
}
function container(t) {
  const el = document.getElementById('ticket-close-reminder');
  return el?.dataset.ticketId === t.id ? el : null;
}
export function markCloseReminder(t) {
  const key = keyFor(t);
  try { localStorage.setItem(key, '1'); fallback.delete(key); }
  catch {
    fallback.add(key);
    showToast('The email was sent, but this browser could not save the close reminder. Check the ticket status before leaving.', 'warn', 10000);
  }
  const el = container(t);
  if (el) el.innerHTML = closeReminder(t);
}
export function clearCloseReminder(t) {
  const key = keyFor(t);
  fallback.delete(key);
  try { localStorage.removeItem(key); } catch { /* in-page reminder still clears */ }
  container(t)?.replaceChildren();
}
export function closeReminder(t) {
  if (t.status === 'closed' || t.mergedInto) { clearCloseReminder(t); return ''; }
  const key = keyFor(t);
  let pending = fallback.has(key);
  try { pending = pending || localStorage.getItem(key) === '1'; } catch { /* retain the in-page reminder */ }
  if (!pending) return '';
  return `<div class="ticket-close-reminder" role="status">
    <p><strong>Email sent; closing wasn’t confirmed.</strong> Check the ticket status, then retry closing only. Your email will not be sent again.</p>
    <div><button type="button" class="btn btn-sm" data-action="td.retryCloseOnly" data-ticket-id="${window.escAttr(t.id)}">Retry close only</button>
    <button type="button" class="btn btn-sm" data-action="td.dismissCloseReminder" data-ticket-id="${window.escAttr(t.id)}">Dismiss reminder</button></div>
  </div>`;
}
