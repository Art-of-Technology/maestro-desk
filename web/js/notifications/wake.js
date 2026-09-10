export function wakeNotification(t, now = Date.now()) {
  if (!['open', 'pending', 'escalated', 'gdpr'].includes(t.status)
    || t.deleted_at || t.deletedAt || t.mergedInto || t._mergedIntoUuid) return null;
  if (t.snoozedUntil && new Date(t.snoozedUntil).getTime() > now) return null;
  const at = new Date(t.snoozeWokenAt).getTime();
  if (!t.snoozeWokenAt || !Number.isFinite(at) || at > now || now - at >= 24 * 60 * 60 * 1000) return null;
  return { id: `wake-${t._uuid || t.id}-${new Date(at).toISOString()}`, type: 'wake', color: 'var(--blue)',
    title: 'Snooze elapsed', body: `${t.id} — ${t.subject}`, ticketId: t.id,
    ts: new Date(at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) };
}
