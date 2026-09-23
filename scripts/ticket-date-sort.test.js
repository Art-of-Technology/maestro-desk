import { test, expect } from 'bun:test';
import { ticketDateMs, ticketCreatedLabel } from '../web/js/tickets/date-sort.js';

test('sidebar creation labels show local time without inventing times for date-only records', () => {
  const raw = '2026-09-15T12:34:00Z';
  expect(ticketCreatedLabel({ _createdAt: raw, created: '2026-09-14' })).toBe(new Date(raw).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }));
  expect(ticketCreatedLabel({ created: '2026-09-14' })).toBe('14 Sept 2026');
  expect(ticketCreatedLabel({})).toBe('Creation date unavailable');
  expect(ticketCreatedLabel({ _createdAt: 'bad' })).toBe('Creation date unavailable');
});

test('Updated uses server timestamps instead of alphabetical relative labels', () => {
  const tickets = [
    { updated: '2 min ago', _listUpdatedAt: '2026-09-15T10:58:00Z' },
    { updated: '14 min ago', _listUpdatedAt: '2026-09-15T10:46:00Z' },
    { updated: '1h ago', _listUpdatedAt: '2026-09-15T10:00:00Z' },
  ];
  const ascending = [...tickets].sort((a, b) => ticketDateMs(a, 'updated') - ticketDateMs(b, 'updated'));
  expect(ascending.map(t => t.updated)).toEqual(['1h ago', '14 min ago', '2 min ago']);
  expect([...ascending].sort((a, b) => ticketDateMs(b, 'updated') - ticketDateMs(a, 'updated')).map(t => t.updated)).toEqual(['2 min ago', '14 min ago', '1h ago']);
});
test('new list timestamp takes precedence without changing detail-sync baseline', () => {
  const ticket = { _listUpdatedAt: '2026-09-15T12:00:00Z', _updatedAt: '2026-09-14T12:00:00Z' };
  expect(ticketDateMs(ticket, 'updated')).toBe(Date.parse(ticket._listUpdatedAt));
  expect(ticket._updatedAt).toBe('2026-09-14T12:00:00Z');
});
test('demo labels use a shared clock; unknown dates have a stable fallback', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');
  for (const [label, minutes] of [['just now', 0], ['2 min ago', 2], ['1h ago', 60], ['1d ago', 1440]]) {
    expect(ticketDateMs({ updated: label }, 'updated', now)).toBe(now - minutes * 60000);
  }
  expect(ticketDateMs({ updated: 'unknown' }, 'updated', now)).toBe(0);
});
test('creation sorting retains same-day precision, timezone and date-only support', () => {
  expect(ticketDateMs({ _createdAt: '2026-09-15T12:00:00+02:00' }, 'created')).toBe(Date.parse('2026-09-15T10:00:00Z'));
  expect(ticketDateMs({ created: '2026-09-14' }, 'created')).toBe(Date.parse('2026-09-14'));
});
