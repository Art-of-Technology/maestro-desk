export function mapHistoryEvent(e) {
  return { id: e.id, type: e.kind, author: e.author_label, details: e.details,
    createdAt: e.created_at,
    ts: new Date(e.created_at).toLocaleString('en-GB', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) };
}

export function applySavedActivity(ticket, response) {
  if (!Array.isArray(response?.activity)) return;
  const entries = new Map((ticket.events || []).filter(e => e.id).map(e => [e.id, e]));
  for (const event of response.activity) entries.set(event.id, mapHistoryEvent(event));
  ticket.events = [...entries.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt) || b.id.localeCompare(a.id))
    .concat((ticket.events || []).filter(e => !e.id));
}

export function replaceSavedActivity(ticket, activity) {
  ticket.events = (ticket.events || []).filter(e => !e.id);
  applySavedActivity(ticket, { activity });
}
