import { SESSION } from './state.js';

export function can(key) {
  if (SESSION?.permissions) return SESSION.permissions[key] === true;
  if (SESSION?.isAdmin || SESSION?.isAdmin == null && (SESSION?.role === 'Admin' || SESSION?.role === 'Platform Admin')) return true;
  if (globalThis.window?.isAdmin?.()) return true;
  // Demo personas and older API sessions keep their existing behaviour.
  if (key === 'tools.custom_fields') return SESSION?.canManageCustomFields === true;
  if (['tickets.delete', 'customers.delete', 'customers.merge'].includes(key)) return SESSION?.canDelete === true;
  if (key.startsWith('admin.') || ['tools.templates', 'tools.kb', 'data.ai_reports', 'data.edit_history', 'data.export', 'data.erase'].includes(key)) return false;
  return true;
}

export function canViewTickets() { return can('tickets.view_all') || can('tickets.view_assigned'); }

const actions = {
  'customers.contact_add': ['cust.addContact'],
  'customers.contact_primary': ['cust.setPrimaryContact'],
  'customers.contact_remove': ['cust.removeContact'],
  'customers.edit': ['cust.editDetails', 'td.editContact', 'cust.addNote', 'cust.new'],
  'customers.merge': ['cust.showMergeModal', 'cust.unmerge'],
  'customers.delete': ['cust.bulkDelete', 'cust.deleteNote'],
  'customers.spam': ['cust.unmarkSpam', 'td.unmarkSpam', 'tickets.bulkSpam'],
  'data.export': ['privacy.export', 'td.gdprExport'],
  'data.export_lists': ['cust.export', 'tickets.bulkExport', 'reports.export', 'replyPerformance.summary', 'replyPerformance.details'],
  'data.export_emails': ['emailDownload.open'],
  'data.erase': ['privacy.erase', 'td.gdprErasure'],
  'tickets.create': ['tickets.newTicket'],
  'tickets.reply': ['emailForward.open'],
  'tickets.close': ['td.snooze', 'td.unsnooze', 'snooze.bulkSnooze'],
  'tickets.edit': ['td.unmerge', 'tickets.bulkPriority', 'tickets.bulkTag', 'td.removeTag'],
  'tickets.assign': ['tickets.bulkAssign', 'td.runRules', 'ar.bulkRun'],
  'tickets.delete': ['td.deleteTicket', 'tickets.bulkDelete'],
  'tools.ai': ['td.summarize', 'td.clearSummary'],
};
const actionKeys = Object.fromEntries(Object.entries(actions).flatMap(([key, names]) => names.map(name => [name, key])));
export function actionPermission(element) {
  if (['nt.cancel', 'nt.closePreview'].includes(element.dataset.action)) return null;
  if (element.dataset.action === 'td.deleteTicket' && element.dataset.blankTicket === 'true' && (SESSION?.permissionsLegacy || !SESSION?.permissions)) return null;
  if (element.dataset.action === 'td.setComposeTab') return element.dataset.tab === 'note' ? 'tickets.note' : 'tickets.reply';
  if ((element.dataset.action || '').startsWith('nt.')) return 'tickets.create';
  return element.dataset.permission || actionKeys[element.dataset.action || element.dataset.changeAction || element.dataset.inputAction];
}
export function applyPermissionControls(root) {
  for (const el of root.querySelectorAll('[data-action], [data-change-action], [data-permission]')) {
    const key = actionPermission(el);
    if (key && !key.split(' ').every(can)) {
      if ('disabled' in el) el.disabled = true;
      else { el.setAttribute('aria-disabled', 'true'); el.style.pointerEvents = 'none'; }
      el.setAttribute('title', 'Your role does not allow this action.');
    }
  }
}
