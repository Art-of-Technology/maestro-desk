import { apiGet, getJwt, getWorkspaceId } from '../core/api-client.js';

export const STATUS_CATEGORIES = ['open', 'pending', 'escalated', 'gdpr', 'resolved', 'closed'];
const defaults = STATUS_CATEGORIES.map((key, sort_order) => ({ key, label: key[0].toUpperCase() + key.slice(1), base_key: key, send_survey: key === 'resolved', is_active: true, sort_order }));
let identity, rows = [], ready = false, error = '', loading;
function context() {
  const key = `${getWorkspaceId() || ''}:${getJwt() || ''}`;
  if (identity !== key) { identity = key; rows = []; ready = false; error = ''; loading = null; }
  return key;
}
export function statusOptionsState() { context(); return { ready: !getWorkspaceId() || ready, error, loading: Boolean(loading) }; }
export function statusOptions({ includeRetired = false } = {}) {
  context();
  return (getWorkspaceId() ? rows : defaults).filter(s => includeRetired || s.is_active);
}
export function statusChoice(key) { return statusOptions({ includeRetired: true }).find(s => s.key === key); }
export function selectedStatus(ticket) { return ticket.statusOption || ticket.status; }
export function statusLabel(ticket) { return statusChoice(selectedStatus(ticket))?.label || ticket.statusLabel || ticket.status; }
export function statusSelectOptions(selected, { excludeClosed = false } = {}) {
  const choices = statusOptions().filter(s => !excludeClosed || s.base_key !== 'closed');
  const current = statusChoice(selected);
  if (current && !current.is_active) choices.unshift(current);
  return choices.map(s => `<option value="${window.escAttr(s.key)}" ${s.key === selected ? 'selected' : ''} ${!s.is_active ? 'disabled' : ''}>${window.escHtml(s.label)}${!s.is_active ? ' (retired)' : ''}</option>`).join('');
}
export async function loadStatusOptions(force = false) {
  const key = context();
  if (!getWorkspaceId()) return;
  if (loading) return loading;
  if (ready && !force) return;
  loading = (async () => {
    try {
      const response = await apiGet('/api/v1/ticket-statuses');
      if (key !== context()) return;
      if (!Array.isArray(response.statuses) || response.statuses.some(s => typeof s.key !== 'string' || typeof s.label !== 'string' || !STATUS_CATEGORIES.includes(s.base_key) || typeof s.is_active !== 'boolean' || typeof s.send_survey !== 'boolean')) throw new Error('Invalid status options.');
      rows = response.statuses; ready = true; error = '';
    } catch {
      if (key === context()) { ready = false; error = 'Could not load ticket statuses. Reload to try again.'; }
    } finally { if (key === context()) loading = null; }
  })();
  return loading;
}
