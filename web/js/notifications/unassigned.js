// Independent of the notification priority chain: ownership needs attention
// even when the same ticket also has an SLA or escalation alert.
export function unassignedNotifications(tickets, now = Date.now()) {
  return tickets.filter(t =>
    ['open', 'pending', 'escalated', 'gdpr'].includes(t.status)
    && !t.mergedInto && !t._mergedIntoUuid && !t.deleted_at
    && (t.assignedUserId === undefined ? !t.agent : t.assignedUserId === null)
    && !(t.snoozedUntil && Date.parse(t.snoozedUntil) > now)
  ).map(t => ({
    id: `unassigned-${t._uuid || t.id}`, type: 'unassigned', color: 'var(--amber)',
    title: 'Unassigned ticket', body: `${t.id} — ${t.subject}`, ticketId: t.id, ts: t.updated,
  }));
}
