import { CATEGORIES, TICKETS } from '../core/data.js';
import { apiPatch, getJwt, getWorkspaceId } from '../core/api-client.js';
import { refreshTicketSLA } from './sla.js';
import { showToast } from '../core/toast.js';

export function ticketCategoryKey(t) {
  if (Object.hasOwn(t, 'categoryKey')) return t.categoryKey;
  return CATEGORIES.find(c => c.key.toLowerCase() === (t.category || '').toLowerCase()
    || c.label.toLowerCase() === (t.category || '').toLowerCase())?.key || t.category || null;
}

export function renderTicketCategory(t) {
  const current = ticketCategoryKey(t);
  const options = CATEGORIES.filter(c => c.is_active || c.key === current);
  if (current && !options.some(c => c.key === current)) options.push({ key: current, label: current, is_active: !t._uuid });
  if (!t._uuid && !CATEGORIES.length) {
    for (const key of new Set(TICKETS.map(x => x.category).filter(Boolean))) {
      if (!options.some(c => c.key === key)) options.push({ key, label: key, is_active: true });
    }
  }
  const id = window.escAttr(t.id);
  return `<div class="ticket-property-row"><label for="ticket-category-${id}">Category</label>
    <select class="ts-select" id="ticket-category-${id}" aria-label="Ticket category" data-change-action="td.setCategory" data-ticket-id="${id}">
      <option value=""${current == null ? ' selected' : ''}>Uncategorised</option>
      ${options.map(c => `<option value="${window.escAttr(c.key)}"${c.key === current ? ' selected' : ''}${!c.is_active ? ' disabled' : ''}>${window.escHtml(c.label)}${!c.is_active && t._uuid ? ' (inactive)' : ''}</option>`).join('')}
    </select></div>`;
}

export async function changeTicketCategory(id, value) {
  const t = TICKETS.find(x => x.id === id);
  const key = value || null;
  if (!t || t._categorySaving || ticketCategoryKey(t) === key) return false;
  const workspace = getWorkspaceId(), jwt = getJwt();
  const active = () => getWorkspaceId() === workspace && getJwt() === jwt && TICKETS.find(x => x.id === id) === t;
  t._categorySaving = true;
  try {
    const saved = t._uuid ? (await apiPatch(`/api/v1/tickets/${t._uuid}`, { category_key: key })).ticket.category_key : key;
    if (!active()) return false;
    t.categoryKey = saved;
    // Keep the existing key-based display used by list filters and SLA rules.
    t.category = saved ? saved.charAt(0).toUpperCase() + saved.slice(1) : 'Other';
    refreshTicketSLA(t);
    return true;
  } catch (err) {
    if (active()) showToast(`Couldn't change category: ${err?.message || 'Please try again.'}`, 'error');
    return false;
  } finally {
    t._categorySaving = false;
  }
}
