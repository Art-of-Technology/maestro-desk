// Local native-module regression. Requests stay held until each assertion is ready.
export default async function checkQueueRefresh(page) {
  if (!page.url().startsWith('http://localhost:5173/')) throw new Error('Local fixture only');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  let checks = 0;
  const check = (ok, message) => { if (!ok) throw new Error(message); checks++; };
  const requests = [], errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.route('**/api/v1/tickets/work-index?*', async route => {
    await new Promise(resolve => requests.push({ url: route.request().url(), finish: async (tickets = [], status = 200) => {
      await route.fulfill({ status, json: status === 200 ? { tickets, next: null } : { error: 'Fixture outage' } });
      resolve();
    } }));
  });
  const row = (n, status = 'pending') => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    display_id: `Q-${n}`, subject: `Queue fixture ${n}`, status_key: status, priority_key: 'normal',
    created_at: '2026-09-10T10:00:00Z', updated_at: '2026-09-10T10:00:00Z', tags: [], customer_id: null });
  await page.evaluate(async () => {
    sessionStorage.removeItem('maestro_jwt'); sessionStorage.removeItem('maestro_workspace_id');
    history.replaceState(null, '', '/');
    (await import('/js/core/url-navigation.js')).discardRequestedRoute();
    window.login('Admin', 'Queue tester', 'QT');
    sessionStorage.setItem('maestro_jwt', 'queue-fixture-token');
    sessionStorage.setItem('maestro_workspace_id', '11111111-1111-4111-8111-111111111111');
    (await import('/js/core/data.js')).TICKETS.length = 0;
  });
  const start = () => page.evaluate(async () => {
    (await import('/js/tickets/work-queue.js')).invalidateWorkQueue();
    const router = await import('/js/core/router.js');
    router.updateNavBadges(); // same ordering as the bulk-save finally block
    router.renderPage('tickets');
  });
  const waitRequest = async count => {
    for (let i = 0; requests.length < count && i < 100; i++) await page.waitForTimeout(10);
    check(requests.length === count, `Expected ${count} shared requests, got ${requests.length}`);
  };
  await start(); await waitRequest(1);
  check((await page.locator('#main-area').innerText()).includes('Loading the complete ticket queue'), 'shows loading while shared request is pending');
  await requests[0].finish([row(1)]);
  await page.getByText('Queue fixture 1', { exact: true }).waitFor({ timeout: 5000 });
  check(await page.locator('#ticket-search').isVisible(), 'badge-started request redraws the ticket list');

  await start(); await waitRequest(2);
  await requests[1].finish([], 503);
  await page.locator('[data-action="tickets.retryQueue"]').waitFor({ timeout: 5000 });
  check((await page.locator('#main-area [role="alert"]').innerText()).includes('Could not load all tickets'), 'shared failure displays error and retry');
  await page.locator('[data-action="tickets.retryQueue"]').click(); await waitRequest(3);
  await requests[2].finish([row(2)]);
  await page.getByText('Queue fixture 2', { exact: true }).waitFor({ timeout: 5000 });
  check(await page.locator('#ticket-search').isVisible(), 'retry redraws the recovered list');

  await start(); await waitRequest(4);
  await page.evaluate(async () => (await import('/js/core/router.js')).renderPage('customers'));
  await requests[3].finish([row(3)]);
  await page.waitForFunction(async () => (await import('/js/tickets/work-queue.js')).workQueueState().ready);
  check(await page.evaluate(async () => (await import('/js/core/state.js')).CURRENT_PAGE) === 'customers', 'completion does not navigate away from another page');

  await start(); await waitRequest(5);
  await page.evaluate(async () => {
    window.__queueRefreshOldState = (await import('/js/tickets/work-queue.js')).workQueueState();
    sessionStorage.setItem('maestro_workspace_id', '22222222-2222-4222-8222-222222222222');
    (await import('/js/core/router.js')).renderPage('tickets');
    window.__queueRefreshNewPage = document.querySelector('#main-area .page');
  });
  await waitRequest(6);
  await requests[4].finish([row(4)]);
  await page.evaluate(async () => { await window.__queueRefreshOldState.promise; });
  check(await page.evaluate(() => window.__queueRefreshNewPage.isConnected), 'old workspace completion cannot redraw the new loading state');
  await requests[5].finish([row(5)]);
  await page.getByText('Queue fixture 5', { exact: true }).waitFor({ timeout: 5000 });
  check(!(await page.locator('#main-area').innerText()).includes('Queue fixture 4'), 'old workspace rows are discarded');

  await page.locator('[data-action="tickets.setStatus"][data-status="history"]').click();
  await waitRequest(7);
  check(requests[6].url.includes('scope=history'), 'history scope loads independently');
  await requests[6].finish([row(6, 'resolved')]);
  await page.getByText('Queue fixture 6', { exact: true }).waitFor({ timeout: 5000 });
  check(await page.locator('#ticket-search').isVisible(), 'history list redraws after loading');
  check(errors.length === 0, errors.join('; '));
  return { checks, requests: requests.length };
}
