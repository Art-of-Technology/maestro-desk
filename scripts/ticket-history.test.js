import { describe, expect, test } from 'bun:test';
import { applySavedActivity, replaceSavedActivity } from '../web/js/core/ticket-history.js';

describe('saved ticket history', () => {
  const event = { id: 'server-1', kind: 'agent', author_label: 'Original Agent', details: 'Assigned: Unassigned → Original Agent', created_at: '2026-09-10T12:00:00Z' };
  test('retry responses do not duplicate entries and preserve server author/time', () => {
    const ticket = {};
    applySavedActivity(ticket, { activity: [event] });
    applySavedActivity(ticket, { activity: [event] });
    expect(ticket.events).toHaveLength(1);
    expect(ticket.events[0].author).toBe('Original Agent');
    expect(ticket.events[0].createdAt).toBe(event.created_at);
  });
  test('reload replaces saved history while keeping unrelated local actions', () => {
    const ticket = { events: [{ type: 'system', details: 'Local action' }, { id: 'stale' }] };
    replaceSavedActivity(ticket, [event]);
    expect(ticket.events.map(e => e.id)).toEqual(['server-1', undefined]);
  });
});
