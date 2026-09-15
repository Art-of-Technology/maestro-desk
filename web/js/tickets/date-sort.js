// Keep display labels separate from timestamps used to order tickets.
export function ticketDateMs(ticket, column, now = Date.now()) {
  const raw = column === 'created'
    ? ticket._createdAt || ticket.created
    : ticket._listUpdatedAt || ticket._updatedAt || ticket.updated;
  if (column === 'updated') {
    if (raw === 'just now') return now;
    const relative = /^(\d+)\s*(s|min|h|d) ago$/.exec(raw || '');
    if (relative) return now - Number(relative[1]) * { s: 1000, min: 60000, h: 3600000, d: 86400000 }[relative[2]];
  }
  return Date.parse(raw) || 0;
}
