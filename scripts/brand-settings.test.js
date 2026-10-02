import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('brand navigation groups existing panels and preserves admin visibility', () => {
  const source = readFileSync('web/js/settings/index.js', 'utf8');
  const render = source.slice(source.indexOf('export function renderSettings'), source.indexOf('export function setSettingsTab')).replace('export ', '');
  const hub = readFileSync('web/js/config-hub/index.js', 'utf8').replace('export function', 'function');
  for (const admin of [true, false]) {
    const context = { window: { isAdmin: () => admin, escAttr: String, escHtml: String }, SETTINGS_TAB: 'appearance', settingsAppearance: () => 'BRAND PANEL' };
    const html = runInNewContext(`${render}; renderSettings()`, context);
    expect(html).toContain('BRAND PANEL');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('Brand & portal');
    expect(html.indexOf('Brand settings')).toBeLessThan(html.indexOf('data-tab="appearance"'));
    expect(html.includes('data-tab="email"')).toBe(admin);
    expect(html.includes('data-tab="sender-domain"')).toBe(admin);
    if (admin) expect(html.indexOf('data-tab="sender-domain"')).toBeLessThan(html.indexOf('>Workspace</h2>'));
    expect(runInNewContext(`${hub}; renderConfigHub()`, context)).toMatch(/data-action="settings.setTab"[^>]+data-tab="appearance"/);
  }
});
