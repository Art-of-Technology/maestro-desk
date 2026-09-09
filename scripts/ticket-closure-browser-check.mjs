// Run against scripts/serve-spa.js in an isolated Playwright page signed into
// a demo persona. Live closure responses below are fixtures; no mail is sent.
export default async function checkTicketClosure(page, screenshotDir) {
  if (new URL(page.url()).hostname !== 'localhost') throw new Error('Local fixture only');
  const check = (value, message) => { if (!value) throw new Error(message); };
  const state = () => page.evaluate(async () => {
    const { TICKETS } = await import('/js/core/data.js');
    const { TICKET_SELECTED_IDS } = await import('/js/core/state.js');
    return { tickets: TICKETS.slice(0, 2).map(t => ({ status: t.status, reason: t.closureReason, survey: t.csatRequestedAt })), selected: [...TICKET_SELECTED_IDS] };
  });
  await page.evaluate(async () => (await import('/js/tickets/detail.js')).openTicket('TK-001'));
  await page.locator('.ticket-topbar summary').click();
  await page.getByRole('button', { name: 'Close without resolution', exact: true }).click();
  await page.locator('[data-action="modal.confirm"]').click();
  check(await page.locator('#closure-error').innerText() === 'Choose a closure reason.', 'Missing reason must be rejected');
  await page.selectOption('#closure-reason', 'spam');
  check(await page.locator('#closure-error').innerText() === '', 'Correcting the reason must clear its error');
  await page.keyboard.press('Escape');
  check((await state()).tickets[0].status === 'escalated', 'Cancel must preserve status');
  // Status dropdown cancellation must also preserve the displayed value.
  await page.selectOption('[aria-label="Ticket status"]', 'closed');
  await page.keyboard.press('Escape');
  check(await page.inputValue('[aria-label="Ticket status"]') === 'escalated', 'Cancelled status selection must reset');
  await page.selectOption('[aria-label="Ticket status"]', 'closed');
  await page.selectOption('#closure-reason', 'spam');
  await page.fill('#closure-note', 'Unsolicited <advert>');
  const layouts = [];
  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const box = await page.locator('.closure-modal').boundingBox();
    check(box.x >= 0 && box.x + box.width <= width, 'Closure dialog must fit the viewport');
    const button = await page.locator('[data-action="modal.confirm"]').boundingBox();
    if (width <= 768) check(button.height >= 44, 'Touch action must be at least 44px high');
    if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/respovia-closure-${width}.png` });
    layouts.push({ width, dialogWidth: box.width, buttonHeight: button.height });
  }
  await page.locator('[data-action="modal.confirm"]').click();
  await page.waitForFunction(async () => (await import('/js/core/data.js')).TICKETS[0].status === 'closed');
  const closed = (await state()).tickets[0];
  check(closed.reason === 'spam' && !closed.survey, 'Closure must record its reason without a survey');
  await page.setViewportSize({ width: 1280, height: 900 });
  check(await page.locator('.closure-note').innerText() === 'Unsolicited <advert>', 'Closure note must render as text');
  if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/respovia-closure-detail.png` });
  const stats = await page.evaluate(async () => {
    const { TICKETS } = await import('/js/core/data.js');
    const { computeReportStats } = await import('/js/reports/index.js');
    return computeReportStats([TICKETS[0], { status: 'resolved', sla: 'ok' }]);
  });
  check(stats.resolved === 1 && stats.resolutionRate === 100 && stats.slaCompliance === 100, 'Administrative closures must not distort resolution or SLA rates');
  await page.getByRole('button', { name: 'Reopen', exact: true }).click();
  check((await state()).tickets[0].status === 'open', 'Reopen must restore active status');

  const requests = [];
  let failSecond = true;
  await page.route('**/api/v1/tickets/*/close', async route => {
    const id = route.request().url().split('/').at(-2);
    const body = route.request().postDataJSON();
    requests.push({ id, body });
    const fail = id.endsWith('2') && failSecond;
    if (fail) failSecond = false;
    await route.fulfill({ status: fail ? 503 : 200, contentType: 'application/json', body: JSON.stringify(fail
      ? { error: 'Temporary failure' }
      : { ticket: { status_key: 'closed', closure_reason: body.reason, closure_note: body.note, closed_at: new Date().toISOString() } }) });
  });
  await page.evaluate(async () => {
    const { TICKETS } = await import('/js/core/data.js');
    const { TICKET_SELECTED_IDS, setCurrentTicket } = await import('/js/core/state.js');
    TICKETS[0]._uuid = '00000000-0000-4000-8000-000000000001';
    TICKETS[1]._uuid = '00000000-0000-4000-8000-000000000002';
    TICKET_SELECTED_IDS.add(TICKETS[0].id); TICKET_SELECTED_IDS.add(TICKETS[1].id);
    setCurrentTicket(null);
    (await import('/js/core/router.js')).renderPage('tickets');
  });
  await page.selectOption('[data-change-action="tickets.bulkStatus"]', 'closed');
  await page.selectOption('#closure-reason', 'duplicate');
  await page.locator('[data-action="modal.confirm"]').click();
  await page.getByRole('button', { name: 'Retry failed tickets' }).waitFor();
  check((await state()).selected.join() === 'TK-002', 'Only failed tickets must remain selected');
  check((await state()).tickets[1].status === 'open', 'A failed save must not change local status');
  await page.getByRole('button', { name: 'Retry failed tickets' }).click();
  await page.locator('.closure-modal').waitFor({ state: 'detached' });
  check((await state()).selected.length === 0, 'Successful retry must clear selection');
  check(requests.length === 3 && requests.every(r => r.body.reason === 'duplicate'), 'Retry must only resend the failed closure');
  await page.locator('[data-action="tickets.setStatus"][data-status="closed"]').click();
  check(await page.locator('.tag-closed').count() === 2, 'Closed tickets must remain available in the Closed tab');
  return { layouts, bulkRequests: requests.length, checks: 'single closure, cancellation, escaping, metrics, reopen, bulk failure/retry, closed filter' };
}
