// Isolated browser fixtures: no real email, customer or survey writes.
export default async function checkWorkspace(browser, outDir) {
  let checks = 0;
  const check = (ok, message) => { if (!ok) throw Error(message); checks++; };
  const context = await browser.newContext();
  const page = await context.newPage(), errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  let acceptDialogs = true;
  page.on('dialog', dialog => acceptDialogs ? dialog.accept() : dialog.dismiss());
  await page.route('**/api/**', route => {
    if (!['GET','OPTIONS'].includes(route.request().method())) writes.push(route.request().url());
    return route.fulfill({ status: 200, json: {} });
  });
  try {
    await page.goto('http://localhost:5173');
    await page.waitForFunction(() => typeof window.login === 'function');
    await page.evaluate(async () => {
      window.login('Admin', 'Workspace tester', 'WT');
      const data = await import('/js/core/data.js');
      Object.assign(data.CUSTOMERS[0], { first: 'Synthetic', email: 'synthetic@example.test', preferredLanguage: 'English' });
      data.CANNED_RESPONSES.splice(0, data.CANNED_RESPONSES.length, { id: 'CR-TEST', name: 'Welcome response', category: 'General', text: 'Hello {name}, reference {ticket}.', html: '<p>Hello <strong>{name}</strong>, reference {ticket}.</p>' });
      (await import('/js/layouts/index.js')).getLayoutFields('ticket').find(f => f.key === 'message').required = true;
      (await import('/js/core/state.js')).setCustomerSelected(data.CUSTOMERS[0].id);
      (await import('/js/core/router.js')).renderPage('customers');
    });
    await page.locator('[data-action="cust.newTicket"]').click();
    await page.locator('#compose-new-ticket .ql-editor').waitFor();
    check(await page.locator('.nt-to').innerText() === 'synthetic@example.test', 'Profile primary email prefills');
    check(await page.locator('#nt2-language').inputValue() === 'English', 'Profile language prefills');
    check(await page.locator('#nt2-draft-btn').isVisible(), 'Draft remains available with required first message');
    await page.locator('#nt-subj').fill('Keep the subject');
    await page.locator('#nt-cat').selectOption({ index: 1 });
    await page.locator('#nt-pri').selectOption('high');
    const category = await page.locator('#nt-cat').inputValue();
    await page.getByRole('button', { name: 'Insert response template', exact: true }).click();
    await page.getByRole('button', { name: 'Pin Welcome response', exact: true }).click();
    await page.locator('#modal-container').getByText('Welcome response', { exact: true }).click();
    await page.getByRole('button', { name: 'Insert response', exact: true }).click();
    check((await page.locator('#compose-new-ticket .ql-editor').innerText()).includes('Hello Synthetic, reference {ticket}.'), 'Template fills customer, defers ticket ID');
    check(await page.locator('#compose-new-ticket .ql-editor strong').innerText() === 'Synthetic', 'Response preserves rich formatting');
    check(await page.locator('#nt-subj').inputValue() === 'Keep the subject' && await page.locator('#nt-cat').inputValue() === category && await page.locator('#nt-pri').inputValue() === 'high', 'Response preserves metadata');
    check(await page.locator('#nt-favourites').getByRole('button', { name: 'Welcome response', exact: true }).count() === 1, 'Shared favourites appear in the new composer');
    await page.locator('#nt-favourites').getByRole('button', { name: 'Welcome response', exact: true }).click();
    await page.getByRole('button', { name: 'Insert response', exact: true }).click();
    check((await page.locator('#compose-new-ticket .ql-editor').innerText()).split('Hello Synthetic').length === 3, 'Favourite response appends to existing writing');
    await page.getByRole('button', { name: 'Preview message', exact: true }).click();
    check(await page.locator('iframe[title="Message preview"]').getAttribute('sandbox') === '', 'Preview uses a sandboxed frame');
    await page.keyboard.press('Tab');
    check(await page.getByRole('button', { name: 'Close preview', exact: true }).evaluate(el => el === document.activeElement), 'Preview traps keyboard focus');
    await page.keyboard.press('Escape');
    check(await page.getByRole('button', { name: 'Preview message', exact: true }).evaluate(el => el === document.activeElement), 'Closing preview restores keyboard focus');
    acceptDialogs = false; await page.getByRole('button', { name: 'Close new ticket', exact: true }).click();
    check(await page.locator('.new-ticket-workspace').count() === 1, 'Declining discard keeps unfinished work');
    acceptDialogs = true;
    await page.locator('#compose-new-ticket .ql-editor').focus(); await page.keyboard.press('Control+Shift+Space');
    check(await page.getByRole('dialog', { name: 'Response templates', exact: true }).count() === 1, 'Template shortcut opens the shared picker when idle');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Close new ticket', exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    check(await page.locator('#nt2-send-btn').evaluate(el => el === document.activeElement), 'Workspace wraps backward keyboard focus');
    await page.keyboard.press('Tab');
    check(await page.getByRole('button', { name: 'Close new ticket', exact: true }).evaluate(el => el === document.activeElement), 'Workspace wraps forward keyboard focus');
    for (const width of [1280, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No horizontal overflow at ${width}`);
      check(await page.locator('#nt2-draft-btn').isVisible() && await page.locator('#nt2-send-btn').isVisible(), `Footer reachable at ${width}`);
      await page.screenshot({ path: `${outDir}/new-ticket-workspace-${width}.png` });
    }
    check(writes.length === 0, 'Opening, editing and previewing never writes a ticket');
    await page.locator('#compose-new-ticket .ql-editor').fill('');
    await page.locator('#nt2-draft-btn').click();
    await page.locator('.new-ticket-workspace').waitFor({ state: 'detached' });
    check(await page.evaluate(async () => (await import('/js/core/data.js')).TICKETS[0].subject === 'Keep the subject'), 'Metadata-only draft creates the expected ticket');
    check(await page.locator('[id^="compose-TK-"]').count() > 0, 'Saved draft resumes in the normal conversation');
    await page.evaluate(async () => (await import('/js/core/router.js')).renderPage('tickets'));
    await page.locator('[data-action="tickets.openTicket"]').filter({ hasText: 'Keep the subject' }).click();
    check(await page.locator('[id^="compose-TK-"]').count() > 0, 'Metadata-only draft reopens from the normal ticket queue');
    check(errors.length === 0, `No browser errors: ${errors.join('; ')}`);
    return { checks, writes: writes.length };
  } finally { await context.close(); }
}
