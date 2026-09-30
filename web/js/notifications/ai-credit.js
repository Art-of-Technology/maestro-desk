import { apiGet, apiPost, getWorkspaceId, getJwt } from '../core/api-client.js';

let scope, checked = 0, pending = false, alert = null;
function currentScope() { return JSON.stringify([getWorkspaceId(), getJwt(), !!window.isAdmin?.()]); }
export function creditNotification(refresh) {
  const key = currentScope();
  if (key !== scope) { scope = key; checked = 0; pending = false; alert = null; }
  if (!getWorkspaceId() || !getJwt() || !window.isAdmin?.()) return null;
  if (!pending && Date.now() - checked >= 30000) {
    pending = true; checked = Date.now();
    void apiGet('/api/v1/ai/credit-alert').then(data => {
      if (scope !== key || currentScope() !== key) return;
      alert = data.alert;
      refresh();
    }).catch(() => {
      if (scope === key) alert = null;
    }).finally(() => { if (scope === key) pending = false; });
  }
  if (!alert || alert.dismissed) return null;
  return { id: 'ai-credit-' + alert.since, type: 'ai-credit', title: 'AI credit is running low',
    body: `$${(Math.max(0, alert.balance_micro) / 1000000).toFixed(2)} remaining. Ask a platform administrator to add credit.`,
    color: 'var(--amber)', ticketId: '', ts: '', read: alert.read };
}
export async function acknowledgeCredit(id, dismissed = false) {
  if (!alert || id !== 'ai-credit-' + alert.since) return;
  const key = scope, since = alert.since;
  await apiPost('/api/v1/ai/credit-alert', { since, dismissed });
  if (scope === key && currentScope() === key && alert?.since === since) {
    alert.read = true; alert.dismissed ||= dismissed;
  }
}
