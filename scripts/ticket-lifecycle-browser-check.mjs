// Native-module acceptance with page-local API fixtures; never touches production.
export default async function checkLifecycleHistory(page) {
  if (!page.url().startsWith('http://localhost:5173/')) throw new Error('Local fixture only');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  let checks = 0;
  const check = (ok, message) => { if (!ok) throw new Error(message); checks++; };
  const errors = [], queries = [];
  page.on('pageerror', e => errors.push(e.message));
  const ticket = { id: '00000000-0000-4000-8000-000000000506', display_id: 'TK-506', subject: 'Lifecycle history fixture',
    status_key: 'pending', priority_key: 'normal', customer_id: null, assigned_user_id: null,
    created_at: '2026-09-10T10:00:00Z', updated_at: '2026-09-10T10:00:00Z', messages: [], tags: [], activity: [] };
  const agent = '00000000-0000-4000-8000-000000000507';
  const event = (kind, details, author = 'Verified server actor') => {
    const e = { id: `00000000-0000-4000-8000-${String(ticket.activity.length + 1).padStart(12, '0')}`, kind, details,
      author_label: author, created_at: `2026-09-10T11:00:0${ticket.activity.length}.000123Z` };
    ticket.activity.unshift(e); return [e];
  };
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.route('**/api/v1/tickets/**', async route => {
    const req = route.request(), url = req.url();
    let activity = [];
    if (req.method() === 'GET') return route.fulfill({ json: { ticket } });
    if (url.includes('/snooze')) {
      if (req.method() === 'POST') {
        const body = req.postDataJSON();
        ticket.snoozed_until = body.until; ticket.snooze_reason = body.reason;
        ticket.snoozed_at = '2026-09-10T11:00:00Z'; ticket.snoozed_by_user_id = agent;
        activity = event('snooze', `Snooze: Not snoozed → ${body.until} · ${body.reason}`);
      } else if (!url.includes('via_wakeup=true')) {
        ticket.snoozed_until = null; ticket.snooze_reason = null; ticket.snoozed_at = null;
        activity = event('snooze', 'Snooze: Waiting → Not snoozed');
      } // stale automatic wake returns the still-active snooze unchanged
    } else if (url.endsWith('/apply-rules')) {
      ticket.assigned_user_id = agent;
      activity = event('agent', 'Assigned: Unassigned → Fixture agent (Rule: Support team)');
      return route.fulfill({ json: { matched: true, ticket, activity, rule: { id: agent, name: 'Support team' } } });
    } else if (url.endsWith('/close')) {
      ticket.status_key = 'closed'; ticket.closure_reason = req.postDataJSON().reason;
      ticket.closure_note = req.postDataJSON().note; ticket.closed_by_user_id = agent; ticket.closed_at = '2026-09-10T11:01:00Z';
      activity = event('status', 'Status: open → closed');
    } else if (req.method() === 'PATCH') {
      ticket.status_key = req.postDataJSON().status_key;
      activity = event('status', 'Status: pending → open');
    }
    return route.fulfill({ json: { ticket, activity } });
  });
  await page.route('**/api/v1/activity?*', route => {
    const url = route.request().url(); queries.push(url);
    const kind = url.includes('kind=snooze') ? 'snooze' : url.includes('kind=status') ? 'status' : null;
    return route.fulfill({ json: { events: ticket.activity.filter(e => !kind || e.kind === kind).map(e => ({ ...e,
      entity: 'ticket', entity_uuid: ticket.id, entity_id: ticket.display_id, entity_name: ticket.subject })), next_cursor: null } });
  });
  const setup = async () => page.evaluate(async ({ ticket, agent }) => {
    sessionStorage.removeItem('maestro_jwt'); sessionStorage.removeItem('maestro_workspace_id');
    history.replaceState(null, '', '/');
    (await import('/js/core/url-navigation.js')).discardRequestedRoute();
    window.login('Admin', 'Browser actor must not be recorded', 'BA');
    sessionStorage.setItem('maestro_jwt', 'lifecycle-fixture-token');
    sessionStorage.setItem('maestro_workspace_id', '11111111-1111-4111-8111-111111111111');
    (await import('/js/core/api-client.js')).setWorkspaceSlug('lifecycle-fixture');
    const { TICKETS, AGENTS } = await import('/js/core/data.js');
    AGENTS.push({ userId: agent, id: 'A506', name: 'Fixture agent', active: true });
    TICKETS.length = 0;
    TICKETS.push({ _uuid: ticket.id, _detailLoaded: false, id: ticket.display_id, subject: ticket.subject,
      status: ticket.status_key, priority: 'normal', sla: 'ok', agent: '', customerId: null, category: 'Other', created: ticket.created_at,
      tags: [], aiTags: [], msgs: [], timeEntries: [], events: [] });
    await (await import('/js/core/bootstrap.js')).loadTicketDetail(ticket.display_id);
    (await import('/js/tickets/detail.js')).openTicket(ticket.display_id);
  }, { ticket, agent });
  const snapshot = () => page.evaluate(async () => (await import('/js/core/data.js')).TICKETS.find(t => t.id === 'TK-506'));
  const waitEvents = count => page.waitForFunction(async count =>
    (await import('/js/core/data.js')).TICKETS.find(t => t.id === 'TK-506')?.events?.length === count, count);
  await setup();
  await page.getByLabel('Ticket status', { exact: true }).selectOption('open');
  await waitEvents(1);
  check((await snapshot()).events[0].author === 'Verified server actor', 'status uses the saved actor');
  check((await snapshot()).events.every(e => e.id), 'status adds no browser-only duplicate');

  await page.getByText('More ▾', { exact: true }).click();
  await page.locator('[data-action="td.snooze"]').click();
  await page.locator('#snz-reason').fill('Waiting <img src=x onerror=alert(1)>');
  await page.locator('[data-action="modal.confirm"]').click();
  await waitEvents(2);
  check((await snapshot()).snoozedAt === '2026-09-10T11:00:00Z', 'snooze uses server timestamps');
  check(await page.locator('#main-area img[src="x"]').count() === 0, 'snooze history escapes supplied text');
  await page.evaluate(async () => (await import('/js/tickets/snooze.js')).unsnoozeTicket('TK-506', true));
  check(Boolean((await snapshot()).snoozedUntil), 'stale wake response preserves the newer snooze');
  check((await snapshot()).events.length === 2, 'stale wake adds no invented event');
  await page.evaluate(async () => (await import('/js/tickets/snooze.js')).unsnoozeTicket('TK-506', false));
  check(!(await snapshot()).snoozedUntil && (await snapshot()).events.length === 3, 'manual wake applies saved state and history');
  await page.getByText('More ▾', { exact: true }).click();
  await page.locator('[data-action="td.runRules"]').click();
  await waitEvents(4);
  check((await snapshot()).assignedUserId === agent, 'rule assignment uses confirmed assignee');
  check((await snapshot()).events[0].details.includes('Support team'), 'rule name appears in saved history');
  await page.getByLabel('Ticket status', { exact: true }).selectOption('closed');
  await page.locator('#closure-reason').selectOption('other');
  await page.locator('#closure-note').fill('Keep the closure decision');
  await page.locator('[data-action="modal.confirm"]').click();
  await waitEvents(5);
  await page.getByText('A new customer reply reopens the ticket.', { exact: false }).waitFor();
  check((await snapshot()).events.every(e => e.id), 'closure and rules have no browser-only duplicates');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload(); await setup();
  check((await snapshot()).events.length === 5, 'all lifecycle history survives a full reload');
  await page.getByRole('button', { name: 'View all activity', exact: true }).click();
  await page.getByLabel('Type', { exact: true }).selectOption('snooze');
  await page.waitForFunction(() => document.querySelectorAll('.saved-activity-page tbody tr').length === 2);
  check(queries.at(-1).includes('kind=snooze'), 'snooze history is filtered on the server');
  await page.getByLabel('Type', { exact: true }).selectOption('status');
  await page.getByText('Status: open → closed', { exact: true }).waitFor();
  check(queries.at(-1).includes('kind=status'), 'status history is filtered on the server');
  check(errors.length === 0, 'native modules have no runtime errors: ' + errors.join('; '));
  return { checks, history: ticket.activity.length };
}
