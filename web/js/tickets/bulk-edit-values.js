export const normaliseBulkTag = raw => String(raw || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

export function confirmsBulkEdit(kind, value, response, ticket) {
  return kind === 'tag' ? response?.tag === value
    : response?.ticket?.id === (ticket._uuid || ticket.id) && response.ticket.priority_key === value;
}
