// Native-module browser acceptance; run only against the intercepted local SPA.
export default async function checkBulkAssignment(page) {
  if (!page.url().startsWith('http://localhost:5173/')) throw new Error('Local fixture only');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  let checks = 0;
  const check = (ok, message) => { if (!ok) throw new Error(message); checks++; };
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const agentId = '00000000-0000-4000-8000-000000000901';
  const otherId = '00000000-0000-4000-8000-000000000902';
  const rows = [1, 2, 3].map(n => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, display_id: `B-${n}`,
    subject: `Bulk assignment ${n}`, status_key: 'pending', priority_key: 'normal',
    category_key: 'general', assigned_user_id: null, customer_id: null, customer_name: 'Fixture',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), tags: [],
  }));
  const requests = [];
  let failSecond = true, holdFirst = true, release = null;
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.route('**/api/v1/tickets/work-index?*', route => route.fulfill({ json: {
    tickets: rows.map(r => ({ ...r, assignee_name: r.assigned_user_id ? 'Same name' : '' })), next: null,
  } }));
  await page.route('**/api/v1/tickets/*', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const id = route.request().url().split('/').pop();
    const body = route.request().postDataJSON();
    requests.push({ id, body, workspace: route.request().headers()['x-workspace-id'] });
    if (holdFirst) { holdFirst = false; await new Promise(resolve => { release = resolve; }); }
    if (id === rows[1].id && failSecond) return route.fulfill({ status: 409, json: { error: 'Ticket changed; please retry.' } });
    const row = rows.find(r => r.id === id);
    row.assigned_user_id = body.assigned_user_id;
    return route.fulfill({ json: { ticket: row } });
  });
  const setup = async () => page.evaluate(async ({ agentId, otherId }) => {
    window.login('Admin', 'Bulk tester', 'BT');
    const { AGENTS, TICKETS } = await import('/js/core/data.js');
    AGENTS.splice(0, AGENTS.length,
      { userId: otherId, name: 'Same name', email: 'other@example.test', active: true },
      { userId: agentId, name: 'Same name', email: 'target@example.test', active: true },
      { userId: 'inactive-id', name: 'Inactive', active: false });
    TICKETS.length = 0;
    sessionStorage.setItem('maestro_jwt', 'fixture-only');
    sessionStorage.setItem('maestro_workspace_id', 'bulk-fixture');
    (await import('/js/tickets/work-queue.js')).invalidateWorkQueue();
    (await import('/js/core/router.js')).renderPage('tickets');
  }, { agentId, otherId });
  const selectTickets = async () => page.evaluate(async () => {
    const { TICKET_SELECTED_IDS } = await import('/js/core/state.js');
    TICKET_SELECTED_IDS.clear();
    for (const id of ['B-1', 'B-2', 'B-3']) TICKET_SELECTED_IDS.add(id);
    (await import('/js/core/router.js')).renderPage('tickets');
  });
  await setup();
  await page.waitForFunction(() => document.getElementById('nb-open').textContent === '3');
  await selectTickets();
  await page.locator('[data-action="tickets.bulkAssign"]').click();
  check(await page.locator('#bulk-agent option').count() === 2, 'Inactive agents are excluded');
  check((await page.locator('#bulk-agent').innerText()).includes('target@example.test'), 'Duplicate names are distinguished');
  await page.locator('#bulk-agent').selectOption(agentId);
  await page.locator('[data-action="modal.confirm"]').click();
  check(await page.locator('[data-action="modal.confirm"]').isDisabled(), 'Save is disabled while request is pending');
  await page.locator('[data-action="modal.confirm"]').dispatchEvent('click');
  check(requests.length === 1, 'Duplicate event does not send duplicate requests');
  check(await page.evaluate(async () => (await import('/js/core/data.js')).TICKETS.every(t => t.assignedUserId === null)), 'Pending requests do not change assignment');
  release();
  await page.waitForFunction(() => document.getElementById('bulk-assignment-result')?.textContent.includes('2 saved; 1 failed'));
  check(requests.length === 3 && requests.every(r => r.body.assigned_user_id === agentId), 'Uses the chosen UUID for every ticket');
  check(await page.evaluate(async () => [...(await import('/js/core/state.js')).TICKET_SELECTED_IDS].join()) === 'B-2', 'Only the failed ticket remains selected');
  check(await page.evaluate(async () => (await import('/js/core/data.js')).TICKETS.find(t => t.id === 'B-2').assignedUserId) === null, 'Failure does not change local assignment');
  failSecond = false;
  await page.getByRole('button', { name: 'Retry failed', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('bulk-agent'));
  check(requests.length === 4 && requests[3].id === rows[1].id, 'Retry only saves the failed ticket');
  await page.waitForFunction(async () => (await import('/js/tickets/work-queue.js')).workQueueState().ready);
  check(await page.evaluate(async () => (await import('/js/core/data.js')).TICKETS.every(t => t.assignedUserId !== null)), 'Full index confirms persisted assignments');
  await page.evaluate(() => sessionStorage.removeItem('maestro_jwt'));
  await page.reload();
  await setup();
  await page.waitForFunction(async () => (await import('/js/tickets/work-queue.js')).workQueueState().ready);
  check(await page.evaluate(async () => (await import('/js/core/data.js')).TICKETS.every(t => t.assignedUserId !== null)), 'Assignments survive a real page reload');
  // Switch context while a real UI request is held: no remaining requests or
  // local updates may apply to the new workspace.
  await selectTickets();
  await page.locator('[data-action="tickets.bulkAssign"]').click();
  await page.locator('#bulk-agent').selectOption(otherId);
  holdFirst = true;
  await page.locator('[data-action="modal.confirm"]').click();
  const beforeSwitch = requests.length;
  await page.evaluate(() => sessionStorage.setItem('maestro_workspace_id', 'other-bulk-fixture'));
  release();
  await page.waitForFunction(() => !document.getElementById('bulk-agent'));
  check(await page.locator('#bulk-agent').count() === 0, 'Stale assignment dialog closes after a workspace change');
  check(requests.length === beforeSwitch, 'Workspace change stops remaining requests');
  check(requests.at(-1).workspace === 'bulk-fixture', 'In-flight request retains original workspace');
  check(await page.evaluate(async () => (await import('/js/core/data.js')).TICKETS.every(t => t.assignedUserId === '00000000-0000-4000-8000-000000000901')), 'Late response does not update the new context');
  check(errors.length === 0, errors.join('; '));
  return { passed: true, checks, requests: requests.length };
}
