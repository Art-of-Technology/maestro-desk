// Keep display labels separate from timestamps used to order tickets.
export function ticketCreatedLabel(ticket) {
  const raw = ticket._createdAt || ticket.created;
  if (!raw || !Number.isFinite(Date.parse(raw))) return 'Creation date unavailable';
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const date = new Date(dateOnly ? `${raw}T00:00:00` : raw);
  return date.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    ...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }),
  });
}

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
