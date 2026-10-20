import { describe, expect, it } from 'bun:test';
import { validateStatusReason } from './lib/ticket-status.js';

describe('ticket status reason validation', () => {
  const reasons = [{ key: 'review', label: 'Review needed', is_active: true }, { key: 'old', label: 'Old reason', is_active: false }];
  it('requires active reasons only when configured, and rejects unknown or retired selections', () => {
    expect(validateStatusReason({ reason_required: false, reasons })).toBeNull();
    expect(validateStatusReason({ reason_required: true, reasons }, 'review')?.label).toBe('Review needed');
    for (const key of [null, '', undefined, 'old', 'unknown']) expect(() => validateStatusReason({ reason_required: true, reasons }, key)).toThrow();
    expect(() => validateStatusReason({ reason_required: false, reasons }, 'old')).toThrow();
  });
});
