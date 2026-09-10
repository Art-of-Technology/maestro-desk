import { describe, expect, it } from 'bun:test';
import { wakeNotification } from '../web/js/notifications/wake.js';
const now = Date.parse('2026-09-10T14:00:00Z');
const ticket = (overrides = {}) => ({ id: 'TK-1', _uuid: 'ticket-1', subject: 'Help', status: 'pending',
  snoozeWokenAt: new Date(now - 1000).toISOString(), ...overrides });
describe('server wake notifications', () => {
  it('restores a saved wake after login and keeps its identity across reloads/edits', () => {
    const original = wakeNotification(ticket(), now);
    expect(original.type).toBe('wake');
    expect(wakeNotification(JSON.parse(JSON.stringify(ticket({ updated: 'Later' }))), now).id).toBe(original.id);
  });
  it('gives each snooze cycle and each ticket its own notification identity', () => {
    const first = wakeNotification(ticket(), now);
    expect(wakeNotification(ticket({ snoozeWokenAt: new Date(now).toISOString() }), now).id).not.toBe(first.id);
    expect(wakeNotification(ticket({ _uuid: 'other-ticket' }), now).id).not.toBe(first.id);
  });
  it('excludes completed, merged, deleted and newly snoozed tickets', () => {
    for (const changes of [{ status: 'closed' }, { status: 'resolved' }, { mergedInto: 'TK-2' },
      { _mergedIntoUuid: 'other' }, { deleted_at: 'today' }, { snoozedUntil: new Date(now + 1000).toISOString() }]) {
      expect(wakeNotification(ticket(changes), now)).toBeNull();
    }
  });
  it('retains the existing 24-hour window and rejects missing, invalid or future timestamps', () => {
    for (const at of [null, 'invalid', new Date(now + 1).toISOString(), new Date(now - 86400000).toISOString()]) {
      expect(wakeNotification(ticket({ snoozeWokenAt: at }), now)).toBeNull();
    }
    for (const status of ['open', 'pending', 'escalated', 'gdpr']) expect(wakeNotification(ticket({ status }), now)).not.toBeNull();
  });
});
