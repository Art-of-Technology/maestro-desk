import { describe, expect, it } from 'bun:test';
import { customerContextLine } from './triage.js';

const full = {
  customer_label: 'Jane Doe',
  customer_vip_tier: 'Gold',
  customer_brand: 'Acme Casino',
  customer_jurisdiction: 'MT',
};

describe('customerContextLine — player-account minimisation', () => {
  it('drops ALL customer attributes (VIP, brand, jurisdiction) when enrichment is OFF — name only', () => {
    const line = customerContextLine(full, false);
    expect(line).toBe('Jane Doe');
    expect(line).not.toContain('Gold');
    expect(line).not.toContain('Acme Casino');
    expect(line).not.toContain('MT');
  });

  it('includes VIP tier, brand and jurisdiction when enrichment is ON', () => {
    const line = customerContextLine(full, true);
    expect(line).toBe('Jane Doe · VIP Gold · Acme Casino · MT');
  });

  it('handles missing optional fields gracefully', () => {
    expect(customerContextLine({ customer_label: 'Jane', customer_vip_tier: null, customer_brand: null, customer_jurisdiction: null }, true)).toBe('Jane');
    expect(customerContextLine({ customer_label: 'Jane', customer_vip_tier: 'Gold', customer_brand: 'Acme', customer_jurisdiction: 'MT' }, false)).toBe('Jane');
  });
});
