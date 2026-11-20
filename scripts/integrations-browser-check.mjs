// Local fixture check for the Integrations page (Configuration → Integrations).
// Serve web/ on http://localhost:5173 and pass a Playwright page.
export default async function checkIntegrations(page) {
  const check = (ok, message) => { if (!ok) throw Error(message); };
  const workspace = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const hook = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'CRM sync', url: 'https://receiver.example.test/hook',
    events: ['ticket.created', 'ticket.closed'], active: true, last_delivery_at: null, last_delivery_status: null, last_delivery_error: null };
  const calls = [];
  let releaseSlack = null;
  await page.addInitScript(() => { try { localStorage.setItem('webhooks', '[{"id":"WH-001"}]'); } catch (e) {} });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), method = route.request().method();
    const body = ['PUT', 'PATCH', 'POST'].includes(method) ? route.request().postDataJSON() : null;
    if (url.pathname.startsWith('/api/v1/integrations/')) calls.push({ method, path: url.pathname, body });
    if (url.pathname === '/api/v1/integrations/slack' && method === 'GET') {
      if (releaseSlack) await releaseSlack;
      return route.fulfill({ json: { integration: { channel: null, active: true, events: ['ticket.created'], has_webhook: true, has_bot_token: false, has_signing_secret: false } } });
    }
    if (url.pathname === '/api/v1/integrations/slack/test') return route.fulfill({ json: { ok: true } });
    if (url.pathname === '/api/v1/integrations/webhooks' && method === 'GET') return route.fulfill({ json: { webhooks: [hook] } });
    if (url.pathname === `/api/v1/integrations/webhooks/${hook.id}` && method === 'PATCH') return route.fulfill({ json: { webhook: { ...hook, ...body } } });
    if (url.pathname === '/api/v1/integrations/postmark/suppressed/contacts') return route.fulfill({ json: { suppressed: [] } });
    return route.fulfill({ json: {} });
  });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));

  await page.goto('http://localhost:5173'); await page.waitForFunction(() => typeof window.login === 'function');
  await page.evaluate(() => window.login('Admin', 'Review Agent', 'RA'));
  await page.waitForTimeout(200);
  check(await page.evaluate(() => localStorage.getItem('webhooks')) === null, 'Leftover browser webhooks are cleared');
  await page.evaluate(async ({ workspace }) => {
    (await import('/js/guides/index.js')).closeGuides();
    const a = await import('/js/core/api-client.js'), s = await import('/js/core/state.js');
    a.setJwt('fixture'); a.setWorkspaceId(workspace); s.setSession({ ...s.SESSION, userId: 'fixture' });
    (await import('/js/core/router.js')).nav('config');
  }, { workspace });

  // Configuration hub: one Integrations card, no Webhooks card.
  check(await page.locator('.confighub-card', { hasText: 'Webhooks' }).count() === 0, 'Webhooks card is gone');
  await page.locator('.confighub-card', { hasText: 'Integrations' }).click();
  await page.locator('.tb-title', { hasText: 'Integrations' }).waitFor();
  await page.getByText('CRM sync', { exact: true }).waitFor();
  await page.getByText('No suppressed addresses.').waitFor();
  check(await page.locator('#slack-evt-ticket\\.created').isChecked(), 'Saved Slack events load');
  check(await page.locator('.settings-h').allTextContents().then(t => t.join('|')) === 'Slack|Outgoing webhooks|Postmark suppression list', 'All three sections render');

  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(300);
    check(await page.locator('.page-scroll').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'No horizontal overflow at ' + width);
  }

  // Slack test alert goes through the new action names.
  await page.getByRole('button', { name: 'Send test alert' }).click();
  await page.getByText('Slack accepted the test alert.', { exact: false }).waitFor();

  // Editing a webhook keeps ticket.closed (the old form silently dropped it).
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  check(await page.locator('#we-evt-ticket\\.closed').isChecked(), 'Edit form shows ticket.closed');
  await page.locator('#we-name').fill('CRM sync v2');
  await page.locator('.modal').getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('CRM sync v2', { exact: true }).waitFor();
  const patch = calls.find(c => c.method === 'PATCH');
  check(patch && patch.body.events.includes('ticket.closed') && patch.body.events.includes('ticket.created'), 'Edit keeps every subscribed event');
  check(await page.locator('.tb-title').textContent() === 'Integrations', 'Saving stays on the Integrations page');

  // Settings no longer has an Integrations tab.
  await page.evaluate(async () => { (await import('/js/core/router.js')).nav('settings'); });
  await page.locator('.settings-tab').first().waitFor();
  check(await page.locator('.settings-tab', { hasText: 'Integrations' }).count() === 0, 'Settings has no Integrations tab');

  // A slow load must not pull the user back after they navigate away.
  let finish; releaseSlack = new Promise(resolve => { finish = resolve; });
  await page.reload(); await page.waitForFunction(() => typeof window.login === 'function');
  await page.evaluate(() => window.login('Admin', 'Review Agent', 'RA'));
  await page.waitForTimeout(200);
  await page.evaluate(async ({ workspace }) => {
    (await import('/js/guides/index.js')).closeGuides();
    const a = await import('/js/core/api-client.js'), s = await import('/js/core/state.js'), r = await import('/js/core/router.js');
    a.setJwt('fixture'); a.setWorkspaceId(workspace); s.setSession({ ...s.SESSION, userId: 'fixture' });
    r.nav('integrations'); r.nav('config');
  }, { workspace });
  finish(); await page.waitForTimeout(300);
  check(await page.locator('.tb-title').textContent() === 'Configuration', 'Late load does not navigate back');

  // Members can look but not change.
  await page.evaluate(async () => {
    const s = await import('/js/core/state.js');
    s.setSession({ ...s.SESSION, permissions: { 'admin.integrations': false } });
    (await import('/js/core/router.js')).nav('integrations');
  });
  await page.getByText('CRM sync', { exact: false }).first().waitFor();
  check(await page.getByRole('button', { name: 'Send test alert' }).isDisabled(), 'Test alert is disabled without permission');
  const before = calls.length;
  await page.locator('[data-action="integrations.saveSlack"]').click();
  check(calls.length === before, 'Save does nothing without permission');

  check(errors.length === 0, 'No page errors: ' + errors.join('; '));
  return { checks: 'hub card, three sections, responsive layout, Slack test alert, webhook edit keeps ticket.closed, Settings tab removed, late-load navigation guard, storage cleanup, permissions' };
}
