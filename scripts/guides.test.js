import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GUIDE_STEPS, GUIDE_VERSION, validateGuideConfig } from '../web/js/guides/config.js';

test('guide registry is valid and every target remains in its owning page', () => {
  expect(GUIDE_VERSION).toContain('dashboard');
  expect(validateGuideConfig()).toBe(true);
  expect(GUIDE_STEPS.length).toBe(5);
  for (const step of GUIDE_STEPS) {
    expect(readFileSync(step.source, 'utf8')).toContain(`data-guide="${step.id}"`);
  }
});
