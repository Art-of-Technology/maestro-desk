// ─── Activity log primitives ─────────────────────────────────────────────────
// Every ticket-mutating module (time-tracking, snooze, linked, AI summarize,
// composer reply, status/priority/agent/tag changes, …) writes to the log
// via logTicketEvent(). Entries land on t.events[]; getTicketEvents() reads
// them back with one synthetic "Ticket created" entry appended for tickets
// that have a created date but no explicit creation event.
//
// Lives in core/ rather than tickets/ because it's a sink that crosses
// every feature, and the read side is consumed by the Activity Log page
// which aggregates from tickets + workflows + customer notes. The page
// renderer itself stays in app.js for now; it'll move out in a follow-on
// PR (alongside WF_SELECTED migration to state.js and the actSetQuery /
// actGotoEntity navigation helpers).
//
// SESSION comes from core/state.js via the global lexical env.

export function logTicketEvent(ticketId, type, details) {
  const t = TICKETS.find(x => x.id === ticketId);
  if (!t) return;
  if (!t.events) t.events = [];
  t.events.unshift({
    type,
    details,
    author: SESSION?.name || 'System',
    ts: new Date().toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }),
  });
}

export function getTicketEvents(t) {
  const seeded = [];
  if (t.created) seeded.push({ type: 'system', details: 'Ticket created', author: 'System', ts: t.created });
  return (t.events || []).concat(seeded);
}
