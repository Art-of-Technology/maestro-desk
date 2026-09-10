// Run with Playwright against the local SPA. Every API call is intercepted.
export default async function checkBulkEdits(page) {
  if (!page.url().startsWith('http://localhost:5173/')) throw new Error('Local fixture only');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  let checks = 0;
  const check = (ok, message) => { if (!ok) throw new Error(message); checks++; };
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const tag = 'priority-customer';
  let rows, requests, failSecond, hold, release, countReads = 0;
  let held, onHeld;
  const holdNext = () => { hold = true; held = new Promise(resolve => { onHeld = resolve; }); };
  const reset = () => {
    rows = [1, 2, 3].map(n => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      display_id: `E-${n}`, subject: `Bulk edit ${n}`, status_key: 'pending', priority_key: 'normal',
      category_key: 'general', assigned_user_id: null, customer_id: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), tags: n === 1 ? [tag] : [],
    }));
    requests = []; failSecond = true; holdNext();
  };
  reset();
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.route('**/api/v1/tickets/work-index?*', route => route.fulfill({ json: { tickets: rows, next: null } }));
  await page.route('**/api/v1/tags', route => {
    countReads++;
    return route.fulfill({ json: { tags: [{ tag, kind: 'manual', ai_confidence: null, count: rows.filter(r => r.tags.includes(tag)).length }] } });
  });
  await page.route('**/api/v1/tickets/**', async route => {
    if (!['PATCH', 'POST'].includes(route.request().method())) return route.fallback();
    const parts = route.request().url().split('/');
    const isTag = parts.at(-1) === 'tags';
    const id = parts.at(isTag ? -2 : -1);
    const body = route.request().postDataJSON();
    requests.push({ id, body });
    if (hold) { hold = false; await new Promise(resolve => { release = resolve; onHeld(); }); }
    if (failSecond && id === rows[1].id) return route.fulfill({ status: 409, json: { error: 'Ticket changed; retry.' } });
    const row = rows.find(r => r.id === id);
    if (isTag) { if (!row.tags.includes(body.tag)) row.tags.push(body.tag); }
    else row.priority_key = body.priority_key;
    return route.fulfill({ json: isTag ? { tag: body.tag } : { ticket: row } });
  });
  const setup = async () => {
    await page.evaluate(async () => {
      sessionStorage.removeItem('maestro_jwt');
      sessionStorage.removeItem('maestro_workspace_id');
      history.replaceState(null, '', '/');
      (await import('/js/core/url-navigation.js')).discardRequestedRoute();
      window.login('Admin', 'Bulk edit tester', 'BE');
      const { TICKETS, TAG_LIBRARY } = await import('/js/core/data.js');
      TICKETS.length = 0;
      TAG_LIBRARY.splice(0, TAG_LIBRARY.length, { tag: 'priority-customer', type: 'manual', count: 1 });
      sessionStorage.setItem('maestro_jwt', 'fixture-only');
      sessionStorage.setItem('maestro_workspace_id', 'bulk-edit-fixture');
      (await import('/js/tickets/work-queue.js')).invalidateWorkQueue();
      (await import('/js/core/router.js')).renderPage('tickets');
    });
    await page.waitForFunction(async () => (await import('/js/tickets/work-queue.js')).workQueueState().ready);
  };
  const select = async () => page.evaluate(async () => {
    const { TICKET_SELECTED_IDS } = await import('/js/core/state.js');
    TICKET_SELECTED_IDS.clear();
    ['E-1', 'E-2', 'E-3'].forEach(id => TICKET_SELECTED_IDS.add(id));
    (await import('/js/core/router.js')).renderPage('tickets');
  });
  const begin = async kind => {
    if (kind === 'priority') await page.locator('[data-change-action="tickets.bulkPriority"]').selectOption('high');
    else {
      await page.locator('[data-action="tickets.bulkTag"]').click();
      await page.getByLabel('Tag', { exact: true }).fill(' Priority Customer! ');
      await page.locator('[data-action="modal.confirm"]').click();
    }
  };
  for (const kind of ['priority', 'tag']) {
    reset(); await setup(); await select(); await begin(kind); await held;
    check(await page.locator('[data-action="modal.confirm"]').isDisabled(), `${kind}: save disabled`);
    await page.locator('[data-action="modal.confirm"]').dispatchEvent('click');
    check(requests.length === 1, `${kind}: duplicate click suppressed`);
    check(await page.evaluate(async kind => {
      const { TICKETS } = await import('/js/core/data.js');
      return kind === 'priority' ? TICKETS.every(t => t.priority === 'normal') : TICKETS.find(t => t.id === 'E-2').tags.length === 0;
    }, kind), `${kind}: no optimistic changes`);
    release();
    await page.waitForFunction(() => document.getElementById('bulk-edit-result')?.textContent.includes('2 saved; 1 failed'));
    check(await page.evaluate(async () => [...(await import('/js/core/state.js')).TICKET_SELECTED_IDS].join()) === 'E-2', `${kind}: only failed ticket selected`);
    check(requests.length === 3, `${kind}: every selected ticket persisted even if cached data matches`);
    failSecond = false;
    await page.getByRole('button', { name: 'Retry failed', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('bulk-edit-value'));
    check(requests.length === 4 && requests[3].id === rows[1].id, `${kind}: retry only failed ticket`);
    if (kind === 'tag') {
      await page.waitForFunction(async () => (await import('/js/core/data.js')).TAG_LIBRARY.find(t => t.tag === 'priority-customer')?.count === 3);
      check(rows.every(r => r.tags.filter(t => t === tag).length === 1), 'Existing tags and retries are idempotent');
      check(countReads >= 2, 'Tag counts refreshed after partial save and retry');
    }
    await page.evaluate(() => sessionStorage.removeItem('maestro_jwt'));
    await page.reload();
    await setup();
    check(await page.evaluate(async kind => {
      const { TICKETS } = await import('/js/core/data.js');
      return kind === 'priority' ? TICKETS.every(t => t.priority === 'high') : TICKETS.every(t => t.tags.includes('priority-customer'));
    }, kind), `${kind}: persisted after full reload`);
    // Dismiss a dialog during a held request. No subsequent requests may run.
    await select(); holdNext(); await begin(kind); await held;
    const before = requests.length;
    await page.evaluate(async () => { window.__bulkQueueBeforeCancel = (await import('/js/tickets/work-queue.js')).workQueueState(); });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    release();
    await page.waitForFunction(async () => {
      const state = (await import('/js/tickets/work-queue.js')).workQueueState();
      return state !== window.__bulkQueueBeforeCancel && state.ready;
    });
    check(requests.length === before, `${kind}: dismissal stops remaining requests`);
  }
  check(errors.length === 0, errors.join('; '));
  return { passed: true, checks };
}
