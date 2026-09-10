// Local native-ESM check. All API requests are intercepted on this page only.
// Pass screenshotPath from the runner when an image artifact is wanted.
export default async function checkHistory(page, { screenshotPath } = {}) {
  if (!page.url().startsWith('http://localhost:5173/')) throw new Error('Local fixture only');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  let checks = 0, fail = true, release, held;
  let holdNext = false, notifyHeld;
  const check = (ok, message) => { if (!ok) throw new Error(message); checks++; };
  const event = { id: 'history-1', created_at: '2026-09-10T12:00:00.000123Z', kind: 'agent',
    author_label: 'Original Agent', entity: 'ticket', entity_uuid: '00000000-0000-4000-8000-000000000001',
    entity_id: 'TK-503', entity_name: 'History fixture', details: 'Assigned: Unassigned → Original Agent <img src=x onerror=alert(1)>' };
  const queries = [];
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.route('**/api/v1/tickets/**', route => route.fulfill({ json: { ticket: {
    id: event.entity_uuid, display_id: event.entity_id, subject: event.entity_name,
    status_key: 'pending', priority_key: 'normal', customer_id: null,
    created_at: event.created_at, updated_at: event.created_at,
    messages: [], tags: [], activity: [event],
  } } }));
  await page.route('**/api/v1/activity?*', async route => {
    const url = route.request().url(); queries.push(url);
    const otherWorkspace = route.request().headers()['x-workspace-id'] === 'other-history-fixture';
    if (holdNext) { holdNext = false; await new Promise(resolve => { release = resolve; notifyHeld(); }); }
    if (otherWorkspace) return route.fulfill({ json: { events: [{ ...event, id: 'other-event', entity_id: 'TK-504', author_label: 'Other workspace agent', details: 'Other workspace change' }], next_cursor: null } });
    if (fail) { fail = false; return route.fulfill({ status: 503, json: { error: 'Fixture outage' } }); }
    if (url.includes('kind=tag')) return route.fulfill({ json: { events: [], next_cursor: null } });
    return route.fulfill({ json: { events: url.includes('cursor=next') ? [event, { ...event, id: 'history-2', details: 'Priority: normal → high' }] : [event],
      next_cursor: url.includes('cursor=next') ? null : 'next' } });
  });
  const setup = () => page.evaluate(async () => {
    sessionStorage.removeItem('maestro_jwt'); sessionStorage.removeItem('maestro_workspace_id');
    history.replaceState(null, '', '/');
    (await import('/js/core/url-navigation.js')).discardRequestedRoute();
    window.login('Admin', 'History tester', 'HT');
    sessionStorage.setItem('maestro_jwt', 'history-fixture-token');
    sessionStorage.setItem('maestro_workspace_id', '11111111-1111-4111-8111-111111111111');
    (await import('/js/core/api-client.js')).setWorkspaceSlug('history-fixture');
    (await import('/js/core/router.js')).renderPage('activity');
  });
  await setup();
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  check((await page.getByRole('status').textContent()).includes('could not be loaded'), 'failed fetch must be visible');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('link', { name: 'TK-503', exact: true }).waitFor();
  check((await page.locator('#main-area tbody').innerText()).includes('Original Agent'), 'saved actor shown');
  check(await page.locator('#main-area tbody img').count() === 0, 'activity text must be escaped');
  check((await page.getByRole('link', { name: 'TK-503', exact: true }).getAttribute('href')) === '#/w/history-fixture/tickets/TK-503', 'readable workspace links use ticket numbers');
  await page.getByRole('link', { name: 'TK-503', exact: true }).click();
  await page.getByRole('button', { name: 'View all activity', exact: true }).waitFor();
  check(await page.evaluate(async () => (await import('/js/core/state.js')).CURRENT_TICKET) === 'TK-503', 'activity link opens a previously unloaded ticket');
  await page.getByRole('button', { name: 'View all activity', exact: true }).click();
  await page.getByRole('button', { name: 'Show all activity' }).click();
  await page.getByRole('link', { name: 'TK-503', exact: true }).waitFor();
  await page.evaluate(async () => {
    (await import('/js/core/api-client.js')).setWorkspaceSlug(null);
    (await import('/js/core/router.js')).renderPage('activity');
  });
  check((await page.getByRole('link', { name: 'TK-503', exact: true }).getAttribute('href')) === '#/w/11111111-1111-4111-8111-111111111111/tickets/' + event.entity_uuid, 'legacy workspace links retain UUIDs');
  await page.evaluate(async () => {
    (await import('/js/core/api-client.js')).setWorkspaceSlug('history-fixture');
    (await import('/js/core/router.js')).renderPage('activity');
  });
  await page.getByRole('button', { name: 'Load more activity' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#main-area tbody tr').length === 2);
  check(await page.locator('#main-area tbody tr').count() === 2, 'pagination de-duplicates returned IDs');
  await page.getByLabel('Type', { exact: true }).selectOption('tag');
  await page.getByText('No activity matches these filters.').waitFor();
  check(queries.at(-1).includes('kind=tag'), 'filter must query all server history');
  await page.getByLabel('Type', { exact: true }).selectOption('all');
  await page.getByRole('link', { name: 'TK-503', exact: true }).waitFor();
  await page.evaluate(async () => (await import('/js/core/activity-feed.js')).showSavedTicketActivity('00000000-0000-4000-8000-000000000001'));
  await page.getByRole('link', { name: 'TK-503', exact: true }).waitFor();
  check(queries.at(-1).includes('ticket=00000000-0000-4000-8000-000000000001'), 'ticket history filters by exact UUID');
  await page.getByRole('button', { name: 'Show all activity' }).click();
  await page.getByRole('link', { name: 'TK-503', exact: true }).waitFor();
  check(!queries.at(-1).includes('ticket='), 'clear ticket filter');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload(); await setup();
  await page.getByRole('link', { name: 'TK-503', exact: true }).waitFor();
  check((await page.locator('#main-area tbody').innerText()).includes('Original Agent'), 'history survives browser reload');
  const metrics = [];
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    metrics.push(await page.evaluate(() => {
      const main = document.querySelector('#main-area');
      const controls = [...main.querySelectorAll('[data-change-action^="savedActivity."], [data-action^="savedActivity."]')].filter(el => el.getBoundingClientRect().width);
      return { width: innerWidth, mainWidth: main.clientWidth, scrollWidth: main.scrollWidth,
        minTargetHeight: Math.min(...controls.map(el => el.getBoundingClientRect().height)),
        color: getComputedStyle(main).color, background: getComputedStyle(document.body).backgroundColor };
    }));
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  if (screenshotPath) await page.screenshot({ path: screenshotPath });
  holdNext = true; held = new Promise(resolve => { notifyHeld = resolve; });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await held;
  await page.evaluate(async () => {
    sessionStorage.setItem('maestro_workspace_id', 'other-history-fixture');
    (await import('/js/core/router.js')).renderPage('activity');
  });
  await page.getByRole('link', { name: 'TK-504', exact: true }).waitFor();
  release();
  await page.waitForTimeout(100);
  check((await page.locator('#main-area tbody').innerText()).includes('Other workspace agent') && !(await page.locator('#main-area tbody').innerText()).includes('Original Agent'), 'late previous-workspace response ignored');
  return { checks, metrics, ...(screenshotPath ? { screenshot: screenshotPath } : {}) };
}
