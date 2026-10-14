export default async function checkCustomerHistory(page) {
  const check = (ok, message) => { if (!ok) throw Error(message); };
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.goto('http://localhost:5173');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.evaluate(() => window.login('Admin', 'History tester', 'HT'));
  await page.evaluate(async () => {
    const { CUSTOMERS, TICKETS } = await import('/js/core/data.js');
    const c = CUSTOMERS[0];
    c.first = 'History'; c.last = 'Fixture';
    c._uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    window.historyFixtureId = c.id;
    TICKETS.length = 0;
    sessionStorage.setItem('maestro_jwt', 'fixture-session');
    sessionStorage.setItem('maestro_workspace_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  });
  const row = n => ({ id: `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, '0')}`, display_id: `TK-900${n}`,
    customer_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', subject: `Older history ticket ${n}`,
    status_key: 'resolved', priority_key: 'normal', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' });
  let fail = false, empty = false;
  await page.route('**/customers/*/summary', route => route.fulfill({ status: fail ? 500 : 200, json: fail ? { error: 'Fixture failure' } : {
    totals: { tickets: empty ? 0 : 3, csat_count: 2, csat_avg: 4.5 }, by_status: { resolved: empty ? 0 : 3 },
    tickets: { rows: empty ? [] : [row(1), row(2)], total: empty ? 0 : 3, limit: 2, offset: 0 },
  } }));
  await page.route('**/customers/*/tickets?*', route => route.fulfill({ json: { rows: [row(3)], limit: 2, offset: 2 } }));
  await page.route('**/tickets/cccccccc-*', route => route.fulfill({ json: { ticket: { ...row(3), messages: [], tags: [], ai_tags: [], time_entries: [] } } }));
  const search = async keyboard => {
    await page.locator('#gs-input').fill('History Fixture');
    if (keyboard) { await page.locator('#gs-input').press('ArrowDown'); await page.locator('#gs-input').press('Enter'); }
    else await page.locator('#gs-results [data-type="customer"]').click();
    await page.waitForSelector('[data-customer-history]');
  };
  await search(false);
  await page.getByRole('button', { name: 'TK-9001', exact: true }).waitFor();
  check(await page.locator('#modal-container').textContent() === '', 'Search opens full profile without popup');
  check((await page.locator('[data-history-counts]').innerText()).includes('4.5'), 'Counts come from server history');
  check(await page.evaluate(async () => (await import('/js/core/data.js')).TICKETS.length) === 0, 'History loading preserves workspace ticket list');
  await page.getByRole('button', { name: 'Load more', exact: true }).click();
  await page.getByRole('button', { name: 'TK-9003', exact: true }).waitFor();
  check(await page.locator('[data-history-status]').innerText() === '3 of 3 tickets', 'Final page is reachable');
  await page.getByRole('button', { name: 'TK-9003', exact: true }).click();
  await page.waitForFunction(async () => (await import('/js/core/state.js')).CURRENT_TICKET === 'TK-9003');
  check(await page.evaluate(async () => (await import('/js/core/data.js')).TICKETS.some(t => t.id === 'TK-9003')), 'Older ticket opens after being loaded');
  await page.evaluate(async () => (await import('/js/customers/modals.js')).openCustomerModal(window.historyFixtureId));
  await page.getByRole('button', { name: 'View full profile', exact: true }).click();
  await page.getByRole('button', { name: 'TK-9001', exact: true }).waitFor();
  check(await page.locator('#modal-container').textContent() === '', 'Popup closes before navigating');
  await page.evaluate(async () => { (await import('/js/core/data.js')).TICKETS.length = 0; (await import('/js/core/router.js')).nav('tickets'); });
  fail = true;
  await search(true);
  await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
  check(!(await page.locator('[data-history-tickets]').innerText()).includes('No tickets'), 'Failure is not an empty history');
  fail = false; empty = true;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-history-tickets]')?.textContent.includes('No tickets'));
  empty = false;
  await search(false);
  await page.getByRole('button', { name: 'TK-9001', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Load more', exact: true }).click();
  await page.getByRole('button', { name: 'TK-9003', exact: true }).waitFor();
  return { checks: 'mouse and keyboard search, popup navigation, server counts, older ticket opening, pagination, retry, empty history, mobile load more' };
}
