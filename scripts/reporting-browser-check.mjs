// Local fixture check: real native modules and UI, intercepted API only.
export default async function checkReporting(page, screenshotDir) {
  if (!page.url().startsWith('http://localhost:5173/')) throw new Error('Local fixture only');
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const queries = [];
  let failQueue = false, failReport = false, invalidQueue = false;
  let queueRequests = 0;
  const row = (n, status = 'pending') => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, display_id: `Q-${n}`,
    subject: n === 205 ? 'Old breach beyond the first page' : `Ticket ${n}`, status_key: status,
    priority_key: 'normal', category_key: 'general', assigned_user_id: null, customer_id: null,
    customer_name: 'Fixture customer', tags: [],
    created_at: new Date(Date.now() - (n === 205 ? 120 : 5) * 60000).toISOString(),
    updated_at: new Date().toISOString(), first_customer_at: null, first_agent_reply_at: null,
  });
  const outstanding = Array.from({ length: 205 }, (_, i) => row(i + 1, i === 0 ? 'escalated' : 'pending'));
  const history = [row(206, 'resolved'), row(207, 'closed')];
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.route('**/api/v1/tickets/work-index?*', route => {
    queueRequests++;
    if (failQueue) return route.fulfill({ status: 500, json: { error: 'Fixture failure' } });
    const url = route.request().url();
    const rows = url.includes('scope=history') ? history : outstanding;
    const offset = url.includes('&after=') ? 200 : 0;
    if (invalidQueue && offset === 200) return route.fulfill({ json: { tickets: [invalidQueue === 'missing' ? null : { ...row(206), category_key: {} }], next: null } });
    return route.fulfill({ json: { tickets: rows.slice(offset, offset + 200), next: rows.length > offset + 200 ? rows[offset + 199].id : null } });
  });
  await page.route('**/api/v1/reports/dashboard?*', route => {
    if (failReport) return route.fulfill({ status: 500, json: { error: 'Fixture failure' } });
    queries.push(route.request().url().split('?')[1]);
    return route.fulfill({ json: { report: { created: 61, resolved: 9, closed: 1, replies: 24,
      byStatus: { pending: 51, resolved: 9, closed: 1 }, byPriority: { normal: 61 }, bySla: { ok: 51 },
      volume: [], recent: [], agents: [{ name: 'Unassigned', n: 51 }], customers: [],
      mine: 0, aiTags: 0, csatCount: 0, avgCSAT: null } } });
  });
  await page.evaluate(async () => {
    window.login('Admin', 'Queue tester', 'QT');
    const { TICKETS, SLA_POLICIES } = await import('/js/core/data.js');
    TICKETS.length = 0;
    SLA_POLICIES.splice(0, SLA_POLICIES.length, { id: 'fixture', status: 'active', priority: 'normal', category: 'all', firstResponseMin: 30, resolutionMin: 60 });
    (await import('/js/tickets/sla.js')).BUSINESS_HOURS.enabled = false;
    sessionStorage.setItem('maestro_jwt', 'fixture-only');
    sessionStorage.setItem('maestro_workspace_id', 'fixture-workspace');
    (await import('/js/tickets/work-queue.js')).invalidateWorkQueue();
    (await import('/js/core/router.js')).renderPage('dashboard');
  });
  await page.waitForFunction(() => document.getElementById('nb-open').textContent === '205');
  check(queueRequests === 2, 'Dashboard alone loads one complete index for the badge');
  await page.locator('.report-kpis').first().waitFor();
  const unchangedReportRequests = queries.length;
  await page.evaluate(async () => {
    window.__reportNode = document.querySelector('.report-kpis');
    await (await import('/js/tickets/list-sync.js')).tick();
  });
  check(queries.length === unchangedReportRequests && queueRequests === 2, 'Empty Dashboard sync must not refetch reports or queue');
  check(await page.evaluate(() => document.querySelector('.report-kpis') === window.__reportNode), 'Empty sync preserves Dashboard DOM');
  const rolled = await page.evaluate(async () => {
    const RealDate = Date;
    const tomorrow = new RealDate(); tomorrow.setDate(tomorrow.getDate() + 1);
    window.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [tomorrow.getTime()])); }
      static now() { return tomorrow.getTime(); }
    };
    try {
      const dashboard = await import('/js/dashboard/index.js');
      const changed = dashboard.dashboardPeriodChanged();
      await (await import('/js/tickets/list-sync.js')).tick();
      return changed;
    } finally { window.Date = RealDate; }
  });
  check(rolled && queries.length > unchangedReportRequests, 'Calendar rollover refreshes an otherwise idle Dashboard');
  await page.evaluate(async () => (await import('/js/core/router.js')).renderPage('tickets'));
  await page.getByRole('button', { name: '205 Outstanding', exact: true }).waitFor();
  await page.evaluate(async () => {
    window.__queueNode = document.querySelector('.tbl');
    await (await import('/js/tickets/list-sync.js')).tick();
  });
  check(queueRequests === 2, 'Empty ticket sync must not fetch the index');
  check(await page.evaluate(() => document.querySelector('.tbl') === window.__queueNode), 'Empty sync preserves ticket DOM');
  await page.evaluate(async () => {
    const data = await import('/js/core/data.js');
    const t = data.TICKETS.find(t => t.id === 'Q-2');
    t.created = new Date(Date.now() - 61 * 60000).toISOString();
    await (await import('/js/tickets/list-sync.js')).tick();
  });
  check(queueRequests === 2, 'Local SLA transition must not fetch the index');
  check(await page.getByRole('button', { name: '2 Out of SLA', exact: true }).count() === 1, 'SLA threshold updates on an empty poll');
  await page.evaluate(async () => {
    (await import('/js/core/data.js')).TICKETS.find(t => t.id === 'Q-2').created = new Date(Date.now() - 5 * 60000).toISOString();
    (await import('/js/core/router.js')).renderPage('tickets');
  });
  check(await page.locator('.tbl tbody tr').count() === 50, 'Only first 50 rows render');
  check((await page.locator('.tbl tbody tr').first().innerText()).includes('Q-205'), 'Old breach from page two must rank first');
  check(await page.getByRole('button', { name: '1 Out of SLA', exact: true }).count() === 1, 'Complete breach count');
  await page.getByRole('button', { name: '1 Out of SLA', exact: true }).click();
  check(await page.locator('.tbl tbody tr').count() === 1, 'Breach headline filters rows');
  await page.getByRole('button', { name: '1 Escalated', exact: true }).click();
  check((await page.locator('.tbl tbody').innerText()).includes('Q-1'), 'Escalation headline filters rows');
  await page.getByRole('button', { name: '205 Outstanding', exact: true }).click();
  await page.getByRole('button', { name: 'Show more (50 of 205)' }).click();
  check(await page.locator('.tbl tbody tr').count() === 100, 'Show more only changes visible rows');
  check(await page.getByRole('button', { name: '205 Outstanding', exact: true }).count() === 1, 'Totals stable after pagination');
  await page.evaluate(async () => {
    (await import('/js/core/data.js')).TICKETS.find(t => t.id === 'Q-205').status = 'escalated';
    (await import('/js/core/router.js')).renderPage('tickets');
  });
  check(await page.getByRole('button', { name: '2 Escalated', exact: true }).count() === 1, 'Breach and escalation may overlap');
  check(await page.getByRole('button', { name: '1 Out of SLA', exact: true }).count() === 1, 'Overlap does not double count breaches');
  await page.locator('[data-action="tickets.setStatus"][data-status="history"]').click();
  await page.getByRole('button', { name: 'History (2)', exact: true }).waitFor();
  check(await page.locator('.tbl tbody tr').count() === 2, 'History includes resolved and closed only');
  await page.getByRole('button', { name: '205 Outstanding', exact: true }).click();
  const layouts = [];
  for (const width of [1920, 1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${screenshotDir}/queue-${width}.png` });
    layouts.push(await page.locator('.queue-kpis').evaluate(el => ({ width: innerWidth, right: el.getBoundingClientRect().right, scroll: document.documentElement.scrollWidth })));
  }
  failQueue = true;
  await page.locator('[data-action="tickets.retryQueue"]').click();
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  check(await page.locator('.queue-kpis').count() === 0, 'Failure must not display partial counts');
  failQueue = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('button', { name: '205 Outstanding', exact: true }).waitFor();
  const beforeInvalid = await page.evaluate(async () => {
    const { TICKETS } = await import('/js/core/data.js');
    window.__originalTicket = TICKETS[0];
    return JSON.stringify(TICKETS);
  });
  invalidQueue = true;
  await page.locator('[data-action="tickets.retryQueue"]').click();
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  check(await page.evaluate(async () => JSON.stringify((await import('/js/core/data.js')).TICKETS)) === beforeInvalid, 'Mapping failure after valid pages must not mutate shared tickets');
  check(await page.evaluate(async () => (await import('/js/core/data.js')).TICKETS[0] === window.__originalTicket), 'Failed load preserves ticket object identity');
  invalidQueue = 'missing';
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  check(await page.evaluate(async () => JSON.stringify((await import('/js/core/data.js')).TICKETS)) === beforeInvalid, 'Missing row must not crash or partially commit');
  invalidQueue = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('button', { name: '205 Outstanding', exact: true }).waitFor();
  await page.evaluate(async () => (await import('/js/core/router.js')).renderPage('dashboard'));
  await page.locator('.report-kpis').first().waitFor();
  check((await page.locator('.report-kpis').first().innerText()).includes('61'), 'Dashboard uses API aggregate');
  for (const period of ['yesterday','this-week','last-week','this-month','last-month','today']) {
    await page.locator('[data-change-action="dash.period"]').selectOption(period);
    await page.locator('.report-kpis').first().waitFor();
  }
  check(queries.length >= 7, 'Every preset requests the selected date range');
  await page.locator('[data-change-action="dash.period"]').selectOption('custom');
  await page.locator('[data-change-action="dash.from"]').fill('2026-01-01');
  await page.locator('[data-change-action="dash.to"]').fill('2026-01-31');
  await page.locator('.report-kpis').first().waitFor();
  check(queries.at(-1).includes('2026-01-'), 'Custom period requested');
  await page.locator('[data-change-action="dash.to"]').fill('2025-12-31');
  await page.getByRole('alert').filter({ hasText: 'End date must' }).waitFor();
  check(await page.locator('.report-kpis').count() === 0, 'Invalid period must hide stale totals');
  await page.locator('[data-change-action="dash.to"]').fill('2026-01-31');
  await page.locator('.report-kpis').first().waitFor();
  for (const width of [1920, 1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${screenshotDir}/dashboard-${width}.png` });
    layouts.push(await page.locator('.report-period').evaluate(el => ({ width: innerWidth, right: el.getBoundingClientRect().right, scroll: document.documentElement.scrollWidth })));
  }
  failReport = true;
  await page.locator('[data-action="dash.refresh"]').first().click();
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  check(await page.locator('.report-kpis').count() === 0, 'Report failure must not show stale totals');
  failReport = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.locator('.report-kpis').first().waitFor();
  check(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  // A slow old-workspace response must never replace the new workspace index.
  let releaseOld;
  const oldGate = new Promise(resolve => { releaseOld = resolve; });
  let oldStarted;
  const oldRequest = new Promise(resolve => { oldStarted = resolve; });
  await page.route('**/api/v1/tickets/work-index?*', async route => {
    const ws = route.request().headers()['x-workspace-id'];
    if (ws === 'fixture-workspace') { oldStarted(); await oldGate; }
    await route.fulfill({ json: { tickets: [row(ws === 'fixture-workspace' ? 300 : 301, 'open')], next: null } });
  });
  await page.evaluate(async () => {
    const queue = await import('/js/tickets/work-queue.js');
    queue.invalidateWorkQueue();
    window.__oldQueueLoad = queue.loadWorkQueue();
    if (queue.loadWorkQueue() !== window.__oldQueueLoad) throw new Error('Concurrent callers must share the pending queue promise');
  });
  await oldRequest;
  await page.evaluate(async () => {
    sessionStorage.setItem('maestro_workspace_id', 'fixture-workspace-b');
    (await import('/js/core/data.js')).TICKETS.length = 0;
    await (await import('/js/tickets/work-queue.js')).loadWorkQueue();
  });
  releaseOld();
  await page.evaluate(() => window.__oldQueueLoad);
  check((await page.evaluate(async () => (await import('/js/core/data.js')).TICKETS.map(t => t.id))).join(',') === 'Q-301', 'Late response must not cross workspace boundary');
  return { queries: queries.length, layouts, errors };
}
