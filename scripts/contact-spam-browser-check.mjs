// Run against scripts/serve-spa.js with a demo persona. Uses local state, never live mail.
export default async function checkContactSpam(page, screenshotDir) {
  if (new URL(page.url()).hostname !== 'localhost') throw new Error('Local fixture only');
  const check = (value, message) => { if (!value) throw new Error(message); };
  await page.evaluate(async () => (await import('/js/tickets/detail.js')).openTicket('TK-001'));
  const layouts = [];
  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const button = await page.getByRole('button', { name: 'Mark as spam', exact: true }).boundingBox();
    check(button.x >= 0 && button.x + button.width <= width, 'Spam action must fit');
    if (width <= 768) check(button.height >= 44, 'Touch button must be 44px high');
    if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/spam-${width}.png` });
    layouts.push({ width, buttonHeight: button.height });
  }
  await page.getByRole('button', { name: 'Mark as spam', exact: true }).click();
  check(await page.locator('.closure-modal').count() === 0, 'Spam has no extra dialog');
  await page.locator('.ticket-header-actions [data-action="td.unmarkSpam"]').click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(async () => {
    const { TICKET_SELECTED_IDS, setCurrentTicket } = await import('/js/core/state.js');
    TICKET_SELECTED_IDS.add('TK-001'); TICKET_SELECTED_IDS.add('TK-002'); setCurrentTicket(null);
    (await import('/js/core/router.js')).renderPage('tickets');
  });
  await page.locator('[data-action="tickets.bulkSpam"]').click();
  const state = await page.evaluate(async () => {
    const { TICKETS, CUSTOMERS } = await import('/js/core/data.js');
    return TICKETS.slice(0, 2).map(t => ({ status: t.status, reason: t.closureReason, spam: CUSTOMERS.find(c => c.id === t.customerId)?.isSpam }));
  });
  check(state.every(t => t.status === 'closed' && t.reason === 'spam' && t.spam), 'Bulk spam must close tickets and flag contacts');
  await page.evaluate(async () => (await import('/js/tickets/detail.js')).openTicket('TK-001'));
  await page.locator('.ticket-header-actions [data-action="td.unmarkSpam"]').click();
  check(await page.locator('[data-action="td.unmarkSpam"]').count() === 0, 'Undo must clear the contact flag');
  check(await page.evaluate(async () => (await import('/js/core/data.js')).TICKETS[0].status === 'closed'), 'Undo must leave old tickets closed');
  return { layouts, checks: 'single click, bulk spam, unmark, responsive button' };
}
