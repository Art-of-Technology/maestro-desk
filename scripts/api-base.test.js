import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../web/js/api-base.js', import.meta.url), 'utf8');
function resolve(hostname, window = {}) {
  runInNewContext(source, { window, location: { hostname } });
  return window;
}

test('company staging uses its own API and environment', () => {
  expect(resolve('staging.respovia.com')).toEqual({
    RESPOVIA_API_BASE: 'https://staging-api.respovia.com', RESPOVIA_ENV: 'staging',
  });
});

test('production and existing preview mappings remain unchanged', () => {
  for (const host of ['respovia.com', 'app.respovia.com', 'www.respovia.com']) {
    expect(resolve(host)).toEqual({ RESPOVIA_API_BASE: 'https://api.respovia.com', RESPOVIA_ENV: 'production' });
  }
  expect(resolve('maestro-desk-git-staging-jodi-1420s-projects.vercel.app').RESPOVIA_API_BASE)
    .toBe('https://maestro-desk-zjkl-git-staging-jodi-1420s-projects.vercel.app');
});

test('unknown hosts do not acquire staging access and overrides survive', () => {
  for (const host of ['localhost', 'staging.respovia.com.attacker.example', 'maestro-desk-git-main-jodi-1420s-projects.vercel.app']) {
    expect(resolve(host)).toEqual({ RESPOVIA_ENV: 'dev' });
  }
  expect(resolve('staging.respovia.com', { RESPOVIA_API_BASE: 'https://custom.example' }))
    .toEqual({ RESPOVIA_API_BASE: 'https://custom.example' });
});
