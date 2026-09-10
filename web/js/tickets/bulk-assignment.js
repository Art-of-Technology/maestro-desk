import { saveBulkChanges } from './bulk-save.js';

export async function saveBulkAssignments({ tickets, agentId, save, isCurrent, onSaved }) {
  return saveBulkChanges({ tickets, isCurrent, onSaved,
    save: ticket => save(ticket, agentId),
    validate: (response, ticket) => response?.ticket?.id === (ticket._uuid || ticket.id)
      && response.ticket.assigned_user_id === agentId,
  });
}
