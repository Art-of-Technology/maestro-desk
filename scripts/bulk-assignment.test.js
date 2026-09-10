import { describe, expect, it } from 'bun:test';
import { saveBulkAssignments } from '../web/js/tickets/bulk-assignment.js';

const tickets = [1, 2, 3].map(n => ({ id: `TK-${n}`, _uuid: `uuid-${n}` }));
const confirm = t => ({ ticket: { id: t._uuid, assigned_user_id: 'agent-id' } });

describe('Bulk assignment persistence', () => {
  it('confirms each save before updating the UI, with one request at a time', async () => {
    let inFlight = 0;
    const events = [];
    const result = await saveBulkAssignments({ tickets, agentId: 'agent-id', isCurrent: () => true,
      save: async t => { expect(++inFlight).toBe(1); events.push(`save:${t.id}`); await Promise.resolve(); inFlight--; return confirm(t); },
      onSaved: t => events.push(`ui:${t.id}`),
    });
    expect(events).toEqual(tickets.flatMap(t => [`save:${t.id}`, `ui:${t.id}`]));
    expect(result.saved).toEqual(tickets);
    expect(result.failed).toEqual([]);
  });
  it('retains only failed tickets for retry without replaying successful saves', async () => {
    const saved = [];
    const result = await saveBulkAssignments({ tickets, agentId: 'agent-id', isCurrent: () => true,
      save: async t => { if (t.id === 'TK-2') throw new Error('Assignee is not an active member'); return confirm(t); },
      onSaved: t => saved.push(t.id),
    });
    expect(saved).toEqual(['TK-1', 'TK-3']);
    expect(result.failed.map(f => f.ticket.id)).toEqual(['TK-2']);
    await saveBulkAssignments({ tickets: result.failed.map(f => f.ticket), agentId: 'agent-id',
      isCurrent: () => true, save: async t => confirm(t), onSaved: t => saved.push(t.id) });
    expect(saved).toEqual(['TK-1', 'TK-3', 'TK-2']);
  });
  it('does not report a malformed or mismatched response as success', async () => {
    for (const response of [{}, { ticket: { id: 'wrong', assigned_user_id: 'agent-id' } }, { ticket: { id: 'uuid-1', assigned_user_id: 'other-agent' } }]) {
      let updates = 0;
      const result = await saveBulkAssignments({ tickets: [tickets[0]], agentId: 'agent-id',
        isCurrent: () => true, save: async () => response, onSaved: () => updates++ });
      expect(updates).toBe(0);
      expect(result.failed).toHaveLength(1);
    }
  });
  it('ignores late responses and stops remaining requests after a workspace change or dismissal', async () => {
    for (const rejects of [true, false]) {
      let current = true, calls = 0, updates = 0;
      const result = await saveBulkAssignments({ tickets, agentId: 'agent-id', isCurrent: () => current,
        save: async t => { calls++; current = false; if (rejects) throw new Error('late failure'); return confirm(t); },
        onSaved: () => updates++,
      });
      expect(calls).toBe(1);
      expect(updates).toBe(0);
      expect(result.cancelled).toBe(true);
    }
  });
  it('does not start saving when the original context is already gone', async () => {
    let calls = 0;
    const result = await saveBulkAssignments({ tickets, agentId: 'agent-id', isCurrent: () => false,
      save: async t => { calls++; return confirm(t); }, onSaved: () => {} });
    expect(calls).toBe(0);
    expect(result.cancelled).toBe(true);
  });
});
