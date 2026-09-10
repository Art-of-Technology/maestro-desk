// Native browser regression: server changes arrive through the full work index.
export default async function checkServerSnooze(page) {
  if (!page.url().startsWith('http://localhost:5173/')) throw Error('Local fixture only');
  await page.evaluate(() => sessionStorage.clear()); await page.reload();
  let checks = 0, deletes = 0;
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const check = (ok, message) => { if (!ok) throw Error(message); checks++; };
  const rows = Array.from({ length: 201 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, display_id: `W-${i + 1}`,
    subject: `Wake fixture ${i + 1}`, status_key: 'pending', priority_key: 'normal', assigned_user_id: 'assigned',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), customer_id: null, tags: [],
  }));
  const target = rows[200];
  target.snoozed_until = new Date(Date.now() - 60000).toISOString();
  await page.route('**/api/**', route => {
    if (route.request().method() === 'DELETE') deletes++;
    return route.fulfill({ json: {} });
  });
  await page.route('**/api/v1/tickets/work-index?*', route => {
    const more = route.request().url().includes('after=');
    const outstanding = rows.filter(t => !['resolved', 'closed'].includes(t.status_key));
    return route.fulfill({ json: { tickets: more ? outstanding.slice(200) : outstanding.slice(0, 200),
      next: more || outstanding.length <= 200 ? null : outstanding[199].id } });
  });
  const setup = () => page.evaluate(async () => {
    sessionStorage.removeItem('maestro_jwt'); sessionStorage.removeItem('maestro_workspace_id');
    history.replaceState(null, '', '/');
    (await import('/js/core/url-navigation.js')).discardRequestedRoute();
    window.login('Admin', 'Wake tester', 'WT');
    sessionStorage.setItem('maestro_jwt', 'wake-fixture-token');
    sessionStorage.setItem('maestro_workspace_id', '11111111-1111-4111-8111-111111111111');
    (await import('/js/core/api-client.js')).setWorkspaceSlug('wake-fixture');
    (await import('/js/core/data.js')).TICKETS.length = 0;
    const { NOTIF_PREFS } = await import('/js/core/state.js');
    NOTIF_PREFS.wake = true; NOTIF_PREFS.unassigned = false;
    const queue = await import('/js/tickets/work-queue.js');
    queue.invalidateWorkQueue(); await queue.loadWorkQueue();
    (await import('/js/core/router.js')).renderPage('notifications');
  });
  const sync = () => page.evaluate(async () => {
    const queue = await import('/js/tickets/work-queue.js');
    queue.invalidateWorkQueue(); await queue.loadWorkQueue();
    (await import('/js/notifications/index.js')).refreshNotifBadge();
  });
  const alert = () => page.locator('[data-action="notif.openFromPage"]').filter({ hasText: 'Snooze elapsed' });
  await setup();
  const wake = await page.evaluate(async () => (await import('/js/tickets/snooze.js')).checkSnoozeWakeups());
  check(!wake && deletes === 0, 'live browser never performs automatic wake requests');
  check(await alert().count() === 0, 'no invented wake notification before the server processes expiry');
  target.snoozed_until = null; target.snooze_woken_at = new Date(Date.now() - 1000).toISOString();
  await sync(); await alert().waitFor();
  check((await alert().innerText()).includes('W-201'), 'server wake outside the first page reaches notifications');
  const firstId = await alert().getAttribute('data-notif-id');
  await page.locator('[data-action="notif.dismiss"]').first().click();
  check(await alert().count() === 0, 'wake notification can be dismissed');
  target.snooze_woken_at = new Date().toISOString();
  await sync(); await alert().waitFor();
  check((await alert().getAttribute('data-notif-id')) !== firstId, 'a subsequent snooze cycle gets a new alert');
  await page.evaluate(() => sessionStorage.clear()); await page.reload(); await setup();
  await alert().waitFor();
  check(await alert().count() === 1, 'saved wake returns after signing back in/reloading');
  target.status_key = 'closed';
  await sync();
  check(await alert().count() === 0, 'completion removes the wake alert');
  check(errors.length === 0, 'native modules have no runtime errors: ' + errors.join('; '));
  return { checks, automaticWakeRequests: deletes };
}
