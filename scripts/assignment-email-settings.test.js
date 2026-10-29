import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync('web/js/settings/index.js', 'utf8');
const functions = source.slice(source.indexOf('function settingsNotifications()'), source.indexOf('function toggleNotifPref('));
test('assignment preference reflects the server value and saves only the chosen email preference', async () => {
  const calls = [], messages = { style: {} }, renders = [];
  let fail = false;
  const context = { ME_PREFS_LOADED: true, ME_PREFS: { mention_email_enabled: true, assignment_email_enabled: false },
    NOTIF_PREFS: {}, window: { escAttr: String }, settingsPushSection: () => '', renderSoundSettings: () => '',
    document: { getElementById: () => messages }, renderPage: page => renders.push(page),
    apiPatch: async (path, body) => { calls.push({ path, body }); if (fail) throw new Error('Synthetic save failure'); return { user: { ...context.ME_PREFS, ...body } }; },
  };
  runInNewContext(functions, context);
  let html = context.settingsNotifications();
  expect(html).toMatch(/aria-label="Assignment emails"\s+data-change-action="settings.setAssignmentEmail"/);
  expect(html).toMatch(/aria-label="Mention emails" checked/);
  await context.setEmailPref('assignment_email_enabled', true);
  expect(calls[0]).toEqual({ path: '/api/v1/me', body: { assignment_email_enabled: true } });
  html = context.settingsNotifications();
  expect(html).toMatch(/aria-label="Assignment emails" checked/);
  expect(context.ME_PREFS.mention_email_enabled).toBe(true);
  fail = true;
  await context.setEmailPref('assignment_email_enabled', false);
  expect(context.ME_PREFS.assignment_email_enabled).toBe(true);
  expect(context.ME_PREFS_LOADED).toBe(false);
  expect(messages.textContent).toBe('Synthetic save failure');
  expect(renders).toEqual(['settings']);
});
