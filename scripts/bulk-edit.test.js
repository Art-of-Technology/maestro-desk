import { describe, expect, it } from 'bun:test';
import { saveBulkChanges } from '../web/js/tickets/bulk-save.js';
import { normaliseBulkTag, confirmsBulkEdit } from '../web/js/tickets/bulk-edit-values.js';

describe('Bulk priority and tag changes', () => {
  it('normalises tags consistently without adding HTML or punctuation', () => {
    expect(normaliseBulkTag(' Priority Customer! ')).toBe('priority-customer');
    expect(normaliseBulkTag('!!!')).toBe('');
    expect(normaliseBulkTag(null)).toBe('');
    expect(normaliseBulkTag('TAG-123')).toBe('tag-123');
  });
  for (const kind of ['priority', 'tag']) {
    const value = kind === 'priority' ? 'high' : 'priority-customer';
    const tickets = [1, 2, 3].map(n => ({ id: `TK-${n}`, _uuid: `uuid-${n}` }));
    const response = t => kind === 'tag' ? { tag: value } : { ticket: { id: t._uuid, priority_key: value } };
    it(`${kind}: updates only confirmed saves and retries only failures`, async () => {
      const updates = [], requests = [];
      const result = await saveBulkChanges({ tickets, isCurrent: () => true,
        save: async t => { requests.push(t.id); if (t.id === 'TK-2') throw new Error('Conflict'); return response(t); },
        validate: (r, t) => confirmsBulkEdit(kind, value, r, t), onSaved: t => updates.push(t.id),
      });
      expect(updates).toEqual(['TK-1', 'TK-3']);
      await saveBulkChanges({ tickets: result.failed.map(f => f.ticket), isCurrent: () => true,
        save: async t => { requests.push(t.id); return response(t); },
        validate: (r, t) => confirmsBulkEdit(kind, value, r, t), onSaved: t => updates.push(t.id),
      });
      expect(requests).toEqual(['TK-1', 'TK-2', 'TK-3', 'TK-2']);
      expect(updates).toEqual(['TK-1', 'TK-3', 'TK-2']);
    });
    it(`${kind}: rejects empty and mismatched confirmations`, () => {
      for (const r of [{}, null, { tag: 'other-tag' }, { ticket: { id: 'other-ticket', priority_key: value } }, { ticket: { id: 'uuid-1', priority_key: 'low' } }]) {
        expect(confirmsBulkEdit(kind, value, r, tickets[0])).toBe(false);
      }
    });
    it(`${kind}: stops after context change and ignores a late successful response`, async () => {
      let current = true, calls = 0, updates = 0;
      const result = await saveBulkChanges({ tickets, isCurrent: () => current,
        save: async t => { calls++; current = false; return response(t); },
        validate: (r, t) => confirmsBulkEdit(kind, value, r, t), onSaved: () => updates++,
      });
      expect(result.cancelled).toBe(true);
      expect(calls).toBe(1);
      expect(updates).toBe(0);
    });
  }
});
