import { can } from '../core/permissions.js';
import { statusOptions, STATUS_CATEGORIES } from './status-options.js';

export const SEND_ACTIONS = [
  { status: '', label: 'Send', hint: 'Keeps the current status. No survey.' },
  { status: 'resolved', label: 'Send & resolve', hint: 'Marks resolved. Surveys follow the brand’s rules.' },
  { status: 'closed', label: 'Send & close', hint: 'Marks closed. No survey.' },
  { status: 'pending', label: 'Send & pending', hint: 'Keeps the ticket outstanding as pending. No survey.' },
  { status: 'escalated', label: 'Send & escalate', hint: 'Keeps the ticket outstanding as escalated. No survey.' },
];

export function sendActions() {
  const choices = statusOptions();
  return [
    ...SEND_ACTIONS.filter(action => !action.status || choices.some(s => s.key === action.status)),
    ...choices.filter(s => !STATUS_CATEGORIES.includes(s.key) && s.base_key !== 'closed')
      .map(s => ({ status: s.key, label: `Send & ${s.label}`, hint: `Sets ${s.label}. ${s.send_survey ? 'Surveys follow the brand’s rules.' : 'No survey.'}` })),
  ].filter(action => !action.status || can('tickets.edit') && can('tickets.close'));
}
