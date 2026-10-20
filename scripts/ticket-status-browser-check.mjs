// Local API fixtures only; no production data or customer email.
export default async function checkTicketStatuses(page, screenshotDir) {
  if (!page.url().startsWith('http://localhost:5173/')) throw Error('Local fixture only');
  const errors = [], requests = [];
  let unavailable = false;
  page.on('pageerror', error => errors.push(error.message));
  const categories = ['open', 'pending', 'escalated', 'gdpr', 'resolved', 'closed'];
  const statuses = categories.map(key => ({ key, label: key[0].toUpperCase() + key.slice(1), base_key: key, is_active: true, send_survey: key === 'resolved' }));
  const ticket = { id: '00000000-0000-4000-8000-000000000991', display_id: 'TK-001', subject: 'Status fixture',
    status_key: 'open', status_option_key: 'open', status_survey_enabled: false, priority_key: 'normal', messages: [], activity: [], tags: [] };
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.route('**/api/v1/ticket-statuses**', async route => {
    const req = route.request();
    if (unavailable) return route.fulfill({ status: 503, json: { error: 'Fixture unavailable' } });
    if (req.method() === 'POST') { const body = req.postDataJSON(); statuses.push({ ...body, key: 'custom-no-survey', is_active: true }); requests.push(body); return route.fulfill({ status: 201, json: { status: statuses.at(-1) } }); }
    if (req.method() === 'PUT') { Object.assign(statuses.at(-1), req.postDataJSON()); return route.fulfill({ json: { status: statuses.at(-1) } }); }
    return route.fulfill({ json: { statuses } });
  });
  await page.route('**/api/v1/tickets/**', route => {
    const req = route.request();
    if (req.method() === 'PATCH') {
      const body = req.postDataJSON(), choice = statuses.find(s => s.key === body.status_option_key);
      requests.push(body); Object.assign(ticket, { status_key: choice.base_key, status_option_key: choice.key, status_survey_enabled: choice.send_survey });
    }
    return route.fulfill({ json: { ticket, activity: [], survey: { sent: false, reason: 'disabled_by_status' } } });
  });
  await page.evaluate(async () => {
    sessionStorage.clear(); window.login('Admin', 'Status fixture', 'SF');
    sessionStorage.setItem('maestro_jwt', 'status-fixture');
    sessionStorage.setItem('maestro_workspace_id', '11111111-1111-4111-8111-111111111111');
    await (await import('/js/tickets/status-options.js')).loadStatusOptions(true);
    (await import('/js/core/router.js')).renderPage('ticket-statuses');
  });
  await page.getByRole('button', { name: 'Add status', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Resolved — no survey');
  await page.getByLabel('Workflow category', { exact: true }).selectOption('closed');
  if (!(await page.getByLabel('Reason required', { exact: true }).isChecked()) || await page.locator('#status-reasons [data-reason-key]').count() !== 4) throw Error('Closure defaults missing');
  await page.getByLabel('Workflow category', { exact: true }).selectOption('pending');
  if (await page.getByLabel('Reason required', { exact: true }).isChecked() || await page.locator('#status-reasons [data-reason-key]').count()) throw Error('Closure reasons leaked into another category');
  await page.getByLabel('Workflow category', { exact: true }).selectOption('closed');
  if (await page.locator('#status-reasons [data-reason-key="spam"]').count() !== 1) throw Error('Returning to Closed lost Spam');
  await page.getByLabel('Workflow category', { exact: true }).selectOption('resolved');
  await page.getByRole('button', { name: 'Save status', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  if (requests[0].send_survey !== false) throw Error('No-survey setting was lost');
  const contrast = await page.evaluate(() => {
    const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((n, v, i) => n + v * [.2126, .7152, .0722][i], 0);
    return ['.report-note', '.status-settings-table th', '.status-settings-table td', '.btn-solid'].map(selector => {
      const el = document.querySelector('.ticket-status-settings ' + selector), color = getComputedStyle(el).color;
      let parent = el, background;
      while (parent) { background = getComputedStyle(parent).backgroundColor; if (background !== 'rgba(0, 0, 0, 0)') break; parent = parent.parentElement; }
      const a = luminance(color), b = luminance(background || 'rgb(255, 255, 255)');
      return { selector, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
    });
  });
  if (contrast.some(c => c.ratio < 4.5)) throw Error('Text contrast failed: ' + JSON.stringify(contrast));
  for (const width of [390, 768, 1280, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 390 && !(await page.locator('.sidebar').evaluate(el => el.classList.contains('collapsed')))) await page.locator('.sb-collapse').click();
    if (width === 1280 && await page.locator('.sidebar').evaluate(el => el.classList.contains('collapsed'))) await page.locator('.sb-collapse').click();
    await page.waitForTimeout(200);
    if (width === 390 && await page.evaluate(() => navigator.maxTouchPoints > 0 && [...document.querySelectorAll('.ticket-status-settings .btn')].some(el => el.getBoundingClientRect().height < 44))) throw Error('Touch targets under 44px');
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error(`Page overflow at ${width}`);
    await page.screenshot({ path: `${screenshotDir}/statuses-${width}.png` });
  }
  await page.getByRole('button', { name: 'Edit Resolved — no survey', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('A long status name '.repeat(4));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screenshotDir}/status-modal-390.png` });
  await page.getByRole('button', { name: 'Save status', exact: true }).focus(); await page.keyboard.press('Tab');
  if (await page.getByRole('button', { name: 'Close dialog' }).evaluate(el => el !== document.activeElement)) throw Error('Dialog focus escaped');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.evaluate(async ticket => {
    const { TICKETS } = await import('/js/core/data.js');
    const t = TICKETS.find(t => t.id === 'TK-001');
    Object.assign(t, { _uuid: ticket.id, _detailLoaded: true, status: 'open', statusOption: 'open', statusSurveyEnabled: false, csat: null, csatRequestedAt: null });
    (await import('/js/tickets/detail.js')).openTicket(t.id);
  }, ticket);
  await page.getByLabel('Ticket status', { exact: true }).selectOption('custom-no-survey');
  await page.waitForFunction(async () => (await import('/js/core/data.js')).TICKETS[0].statusOption === 'custom-no-survey');
  if (!(await page.getByText('This status does not send satisfaction surveys.', { exact: false }).count())) throw Error('No-survey explanation missing');
  await page.getByLabel('Ticket status', { exact: true }).selectOption('closed');
  await page.locator('#closure-reason').waitFor(); await page.keyboard.press('Escape');
  if (await page.getByLabel('Ticket status', { exact: true }).inputValue() !== 'custom-no-survey') throw Error('Cancel lost custom selection');
  if (!(await page.locator('[data-action="td.sendAnd"][data-status="custom-no-survey"]').count())) throw Error('Custom send action missing');
  await page.evaluate(async () => (await import('/js/core/router.js')).renderPage('ticket-statuses'));
  await page.getByRole('button', { name: 'Edit Resolved — no survey', exact: true }).click();
  await page.getByLabel('Reason required', { exact: true }).check();
  await page.getByRole('button', { name: 'Save status', exact: true }).click();
  if (!(await page.locator('#status-error').textContent()).includes('at least one')) throw Error('Empty required reason list accepted');
  await page.getByRole('button', { name: 'Add reason', exact: true }).click();
  await page.getByLabel('Reason name', { exact: true }).fill('Customer confirmed');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screenshotDir}/status-reasons-modal-390.png` });
  await page.getByRole('button', { name: 'Save status', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.evaluate(async () => {
    const { TICKETS } = await import('/js/core/data.js');
    const t = TICKETS.find(t => t.id === 'TK-001'); t.status = 'open'; t.statusOption = 'open';
    (await import('/js/tickets/detail.js')).openTicket(t.id);
  });
  await page.getByLabel('Ticket status', { exact: true }).selectOption('custom-no-survey');
  await page.getByRole('button', { name: 'Set status', exact: true }).click();
  if (await page.locator('#status-reason-error').textContent() !== 'Choose a reason.') throw Error('Required reason not enforced');
  await page.keyboard.press('Escape');
  if (await page.getByLabel('Ticket status', { exact: true }).inputValue() !== 'open') throw Error('Cancel changed status');
  await page.getByLabel('Ticket status', { exact: true }).selectOption('custom-no-survey');
  await page.getByLabel('Reason (required)', { exact: true }).selectOption({ label: 'Customer confirmed' });
  await page.getByRole('button', { name: 'Set status', exact: true }).click();
  await page.waitForFunction(async () => (await import('/js/core/data.js')).TICKETS[0].statusOption === 'custom-no-survey');
  if (!requests.at(-1).status_reason?.startsWith('reason-')) throw Error('Selected reason not sent to API');
  await page.evaluate(async () => (await import('/js/core/router.js')).renderPage('ticket-statuses'));
  await page.getByRole('button', { name: 'Edit Resolved — no survey', exact: true }).click();
  await page.getByLabel('Retired — hide from new selections').check();
  await page.getByRole('button', { name: 'Save status', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.evaluate(async () => (await import('/js/tickets/detail.js')).openTicket('TK-001'));
  const retired = page.getByLabel('Ticket status', { exact: true }).locator('option:checked');
  if (!(await retired.evaluate(el => el.disabled && el.textContent.includes('(retired)')))) throw Error('Retired selection was lost');
  await page.evaluate(async () => (await import('/js/core/router.js')).renderPage('ticket-statuses'));
  unavailable = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Could not load ticket statuses' }).waitFor();
  if (!(await page.getByRole('button', { name: 'Add status', exact: true }).isDisabled())) throw Error('Failed metadata enabled creation');
  await page.evaluate(async () => {
    sessionStorage.clear(); history.replaceState(null, '', '/');
    const routing = await import('/js/core/url-navigation.js'); routing.discardRequestedRoute();
    window.login('Agent', 'Agent fixture', 'AF'); await routing.resumeUrlRouting();
    (await import('/js/core/router.js')).renderPage('ticket-statuses');
  });
  if (!(await page.getByText('Brand admin permission is required', { exact: false }).count())) throw Error('Agent configuration guard missing');
  if (errors.length) throw Error(errors.join('\n'));
  return { screenshots: 5, contrast, checks: 'admin create/retire, no-survey agent selection, closure cancellation, send action, focus trap, Escape, failed loading, agent guard, responsive layouts' };
}
