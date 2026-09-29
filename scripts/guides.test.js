import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GUIDE_STEPS, GUIDE_VERSION, validateGuideConfig } from '../web/js/guides/config.js';

test('guide registry is valid and every target remains in its owning page', () => {
  expect(GUIDE_VERSION).toContain('dashboard');
  expect(validateGuideConfig()).toBe(true);
  expect(GUIDE_STEPS.map(step => step.id)).toEqual(['dashboard', 'tickets', 'review', 'customers', 'knowledge', 'reply', 'templates', 'ai-review', 'send', 'statuses', 'handover', 'agents', 'checklist']);
  for (const step of GUIDE_STEPS) {
    expect(step.highlights.length).toBeLessThanOrEqual(3);
    expect(step.highlights.length).toBeGreaterThan(0);
    expect(step.highlights.every(text => text.length <= 120)).toBe(true);
    expect(readFileSync(step.source, 'utf8')).toContain(`data-guide="${step.target || step.id}"`);
  }
});

test('guide steps require readable instructions', () => {
  for (const instructions of [undefined, [], [''], ['  '], [123]]) {
    expect(() => validateGuideConfig([{ ...GUIDE_STEPS[0], instructions }])).toThrow('Guide instructions are missing');
  }
  for (const highlights of [undefined, [], [''], ['a', 'b', 'c', 'd'], ['a'.repeat(121)]]) {
    expect(() => validateGuideConfig([{ ...GUIDE_STEPS[0], highlights }])).toThrow('Guide highlights must contain');
  }
});
