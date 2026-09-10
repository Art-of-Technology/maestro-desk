import { describe, expect, it } from 'bun:test';
import { unassignedNotifications } from '../web/js/notifications/unassigned.js';

const now = Date.parse('2026-09-10T12:00:00Z');
const ticket = (overrides = {}) => ({ id: 'TK-1', _uuid: 'ticket-uuid', subject: 'Help',
  status: 'open', agent: '', assignedUserId: null, updated: 'Just now', ...overrides });

describe('Unassigned ticket alerts', () => {
  it('includes all four work statuses and excludes completed tickets', () => {
    for (const status of ['open', 'pending', 'escalated', 'gdpr']) {
      expect(unassignedNotifications([ticket({ status })], now)).toHaveLength(1);
    }
    for (const status of ['resolved', 'closed']) {
      expect(unassignedNotifications([ticket({ status })], now)).toHaveLength(0);
    }
  });
  it('uses actual ownership even if the agent directory lacks the name', () => {
    expect(unassignedNotifications([ticket({ assignedUserId: 'agent-uuid', agent: '' })], now)).toEqual([]);
    expect(unassignedNotifications([ticket({ assignedUserId: null, agent: 'Stale name' })], now)).toHaveLength(1);
  });
  it('supports demo tickets without server assignment fields', () => {
    expect(unassignedNotifications([ticket({ assignedUserId: undefined, agent: 'Jodi' })], now)).toEqual([]);
    expect(unassignedNotifications([ticket({ assignedUserId: undefined })], now)).toHaveLength(1);
  });
  it('pauses until the exact snooze deadline', () => {
    const snoozed = ticket({ snoozedUntil: new Date(now + 1).toISOString() });
    expect(unassignedNotifications([snoozed], now)).toEqual([]);
    expect(unassignedNotifications([snoozed], now + 1)).toHaveLength(1);
  });
  it('excludes deleted tickets and merged sources even without a parent display ID', () => {
    for (const overrides of [{ deleted_at: new Date(now).toISOString() }, { mergedInto: 'TK-2' }, { _mergedIntoUuid: 'parent-uuid' }]) {
      expect(unassignedNotifications([ticket(overrides)], now)).toEqual([]);
    }
  });
  it('retains unassigned alerts on breached and escalated tickets', () => {
    const [alert] = unassignedNotifications([ticket({ status: 'escalated', sla: 'breach' })], now);
    expect(alert.type).toBe('unassigned');
    expect(alert.ticketId).toBe('TK-1');
  });
  it('uses unique ticket UUIDs even when two workspaces share display IDs', () => {
    const a = unassignedNotifications([ticket()], now)[0];
    const b = unassignedNotifications([ticket({ _uuid: 'other-workspace-ticket' })], now)[0];
    expect(a.id).not.toBe(b.id);
    expect(unassignedNotifications([ticket({ updated: 'Later' })], now)[0].id).toBe(a.id);
  });
});
