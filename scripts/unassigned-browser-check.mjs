// Run against the local SPA with Playwright; all API requests are fixtures.
export default async function checkUnassigned(page) {
  if (!page.url().startsWith('http://localhost:5173/')) throw new Error('Local fixture only');
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  let checks = 0;
  const check = (ok, message) => { if (!ok) throw new Error(message); checks++; };
  const row = n => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, display_id: `Q-${n}`,
    subject: `Ticket ${n}`, status_key: 'open', priority_key: 'normal', category_key: 'general',
    assigned_user_id: n <= 200 ? 'missing-agent-name' : null, customer_id: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), tags: [],
  });
  const rows = Array.from({ length: 205 }, (_, i) => row(i + 1));
  rows[201].status_key = 'pending';
  rows[202].status_key = 'escalated';
  rows[203].status_key = 'gdpr';
  rows[204].snoozed_until = new Date(Date.now() + 3600000).toISOString();
  let fail = false, pages = 0, emptyWorkspace = false;
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.route('**/api/v1/tickets/work-index?*', route => {
    pages++;
    if (fail) return route.fulfill({ status: 500, json: { error: 'Fixture failure' } });
    if (emptyWorkspace) return route.fulfill({ json: { tickets: [], next: null } });
    const after = route.request().url().includes('&after=');
    return route.fulfill({ json: { tickets: after ? rows.slice(200) : rows.slice(0, 200), next: after ? null : rows[199].id } });
  });
  await page.evaluate(async () => {
    window.login('Admin', 'Alert tester', 'AT');
    const { TICKETS } = await import('/js/core/data.js');
    TICKETS.length = 0;
    sessionStorage.setItem('maestro_jwt', 'fixture-only');
    sessionStorage.setItem('maestro_workspace_id', 'alerts-fixture');
    const { NOTIF_PREFS } = await import('/js/core/state.js');
    NOTIF_PREFS.unassigned = true;
    (await import('/js/tickets/work-queue.js')).invalidateWorkQueue();
    (await import('/js/core/router.js')).renderPage('notifications');
  });
  await page.waitForFunction(() => document.querySelector('option[value="unassigned"]')?.textContent === 'Unassigned (4)');
  check(pages === 2, 'Loads both pages even when only Notifications is opened');
  check(await page.locator('[data-action="notif.openFromPage"]').filter({ hasText: 'Unassigned ticket' }).count() === 4, 'All four work statuses alert');
  check(await page.locator('[data-action="notif.openFromPage"]').filter({ hasText: 'Escalated' }).count() === 1, 'Escalation remains visible alongside unassigned');
  await page.locator('[data-change-action="notif.setFilterType"]').selectOption('unassigned');
  await page.locator('[data-action="notif.markRead"][data-notif-id$="000000000201"]').click();
  await page.evaluate(async () => {
    const { TICKETS } = await import('/js/core/data.js');
    TICKETS.find(t => t.id === 'Q-201').assignedUserId = 'agent';
    (await import('/js/notifications/index.js')).refreshNotifBadge();
  });
  check(await page.locator('[data-action="notif.openFromPage"]').count() === 3, 'Assignment removes alert from the open page');
  await page.evaluate(async () => {
    const { TICKETS } = await import('/js/core/data.js');
    TICKETS.find(t => t.id === 'Q-201').assignedUserId = null;
    TICKETS.find(t => t.id === 'Q-202').status = 'resolved';
    TICKETS.find(t => t.id === 'Q-204').status = 'closed';
    TICKETS.find(t => t.id === 'Q-205').snoozedUntil = new Date(Date.now() - 1).toISOString();
    (await import('/js/notifications/index.js')).refreshNotifBadge();
  });
  check(await page.locator('[data-action="notif.markRead"][data-notif-id$="000000000201"]').count() === 1, 'Re-unassigned ticket is unread again');
  check(await page.locator('[data-action="notif.openFromPage"]').count() === 3, 'Completion clears alerts and elapsed snooze restores one');
  fail = true;
  await page.evaluate(async () => {
    (await import('/js/tickets/work-queue.js')).invalidateWorkQueue();
    (await import('/js/core/router.js')).updateNavBadges();
  });
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  check(await page.locator('#notif-badge').textContent() === '?', 'Failed index is not a false zero');
  check(!await page.locator('#main-area').innerText().then(t => t.includes('All caught up')), 'Failure does not claim all caught up');
  fail = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('option[value="unassigned"]')?.textContent === 'Unassigned (4)');
  await page.evaluate(async () => {
    (await import('/js/core/router.js')).renderPage('settings');
    window.setSettingsTab('notifications');
  });
  const toggle = page.locator('[data-change-action="settings.toggleNotif"][data-key="unassigned"]');
  check(await toggle.isChecked(), 'Preference defaults on');
  await toggle.locator('..').click();
  check(await page.evaluate(() => JSON.parse(localStorage.getItem('notif_prefs')).unassigned) === false, 'Opt out persists');
  await page.evaluate(async () => (await import('/js/core/router.js')).renderPage('notifications'));
  check(await page.locator('option[value="unassigned"]').textContent() === 'Unassigned (0)', 'Opt out hides alerts');
  await page.evaluate(async () => {
    (await import('/js/core/state.js')).NOTIF_PREFS.unassigned = true;
    (await import('/js/notifications/index.js')).refreshNotifBadge();
  });
  await page.locator('#notif-btn').click();
  check(await page.locator('#notif-dropdown .notif-name').filter({ hasText: 'Unassigned ticket' }).count() === 4, 'Bell contains the same complete alerts');
  await page.evaluate(async () => {
    const { TICKETS } = await import('/js/core/data.js');
    TICKETS.find(t => t.id === 'Q-201').assignedUserId = 'agent';
    (await import('/js/notifications/index.js')).refreshNotifBadge();
  });
  check(await page.locator('#notif-dropdown .notif-name').filter({ hasText: 'Unassigned ticket' }).count() === 3, 'Open bell refreshes after assignment');
  // Exercise the real sync callback and its asynchronous full-index refresh.
  rows[200].assigned_user_id = 'agent';
  rows[201].assigned_user_id = 'agent';
  await page.route('**/api/v1/tickets/sync*', route => route.fulfill({ json: {
    tickets: [rows[200], rows[201]], cursor: new Date().toISOString(),
  } }));
  await page.evaluate(async () => (await import('/js/tickets/list-sync.js')).tick());
  await page.waitForFunction(() => document.querySelector('option[value="unassigned"]')?.textContent === 'Unassigned (2)');
  check(await page.locator('#notif-dropdown .notif-name').filter({ hasText: 'Unassigned ticket' }).count() === 2, 'Sync refreshes both notification surfaces after server assignment');
  emptyWorkspace = true;
  await page.evaluate(async () => {
    sessionStorage.setItem('maestro_workspace_id', 'other-alerts-fixture');
    (await import('/js/core/router.js')).updateNavBadges();
  });
  await page.waitForFunction(() => document.getElementById('nb-open').textContent === '0');
  check(await page.locator('#notif-dropdown .notif-name').filter({ hasText: 'Unassigned ticket' }).count() === 0, 'Workspace change removes prior workspace alerts');
  check(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  return { passed: true, queuePagesFetched: pages, checks };
}
