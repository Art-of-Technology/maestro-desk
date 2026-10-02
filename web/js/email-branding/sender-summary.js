import { apiGet, getWorkspaceId, getJwt } from '../core/api-client.js';
import { registerActions } from '../core/event-delegation.js';

async function loadSenderSummary() {
  const panel = document.getElementById('eb-sender-summary');
  const workspace = getWorkspaceId(), jwt = getJwt();
  if (!panel || !workspace || !window.isAdmin()) return;
  const current = () => panel.isConnected && workspace === getWorkspaceId() && jwt === getJwt() && window.isAdmin();
  panel.innerHTML = 'Loading sender…';
  try {
    const { sender_identity: sender } = await apiGet('/api/v1/email-domains');
    if (!current()) return;
    if (!sender || !['workspace', 'platform', 'none'].includes(sender.source)) throw new Error('Missing sender identity');
    if (sender.source !== 'none' && !sender.from_email) throw new Error('Missing sender address');
    panel.innerHTML = sender.source === 'none'
      ? 'Outbound email is not configured.'
      : `<strong style="overflow-wrap:anywhere">${window.escHtml(sender.from_email)}</strong><div>${sender.source === 'workspace' ? 'Brand domain' : 'Platform fallback'}</div>`;
  } catch {
    if (current()) panel.innerHTML = 'Could not load the sender address. <button type="button" class="btn btn-sm" data-action="emailSender.retry">Try again</button>';
  }
}

export function senderSummary() {
  if (!window.isAdmin()) return '';
  // Fetch after the settings markup is mounted; update only this mounted panel.
  queueMicrotask(loadSenderSummary);
  return `<div class="settings-section">
    <div class="settings-h">Default sender</div>
    <div id="eb-sender-summary" role="status" style="font-size:13px;line-height:1.6">Loading sender…</div>
    <p style="font-size:12px;color:var(--ink3)">Ticket replies may use the selected inbox address instead. Check the From field before sending.</p>
    <button type="button" class="btn btn-sm" data-action="settings.setTab" data-tab="sender-domain">Sender domain settings</button>
  </div>`;
}

registerActions({ 'emailSender.retry': loadSenderSummary });
