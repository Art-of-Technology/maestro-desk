// Run with scripts/serve-spa.js. Uses demo customers; creates no tickets.
export default async page => {
  const p = await page.context().newPage();
  let checks = 0, creates = 0;
  const check = (ok, message) => { checks++; if (!ok) throw new Error(message); };
  await p.route('**/api/**', async route => {
    if (route.request().method() === 'POST' && new URL(route.request().url()).pathname.endsWith('/tickets')) creates++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await p.goto('http://localhost:5173');
  await p.waitForFunction(() => typeof window.login === 'function');
  await p.evaluate(() => window.login('Admin', 'Language Tester', 'LT', {userId:'jurisdiction-fixture'}));
  const confirm = () => p.locator('[data-action="modal.confirm"]').click();
  const open = async jurisdiction => {
    await p.evaluate(async jurisdiction => {
      const { CUSTOMERS } = await import('/js/core/data.js');
      CUSTOMERS[0].jurisdiction = jurisdiction;
      CUSTOMERS[0].preferredLanguage = '';
      CUSTOMERS[1].preferredLanguage = '';
      await (await import('/js/tickets/new-ticket.js')).showNewTicketModal(null, CUSTOMERS[0].id);
    }, jurisdiction);
    await p.locator('#nt-subj').fill('Account update');
    await p.locator('#nt-cat').selectOption({index:1});
    await confirm();
  };
  for (const width of [1280, 768, 390]) {
    await p.setViewportSize({width, height:900});
    await open('Chile');
    check(await p.locator('#nt-language').inputValue() === 'Spanish', 'Chile suggests Spanish');
    check(await p.locator('#nt2-msg').count() === 0, 'Cannot write before confirming');
    check(await p.evaluate(() => document.activeElement.id === 'nt-language'), 'Language receives focus');
    check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow at ' + width);
    await p.getByRole('button', {name:'Confirm and continue', exact:true}).focus();
    await p.keyboard.press('Tab');
    check(await p.evaluate(() => document.activeElement.getAttribute('aria-label') === 'Cancel new conversation'), 'Tab stays in dialog');
    await p.keyboard.press('Shift+Tab');
    check(await p.evaluate(() => document.activeElement.textContent === 'Confirm and continue'), 'Shift+Tab stays in dialog');
    await p.screenshot({path:`jurisdiction-language-${width}.png`});
    await p.locator('#nt-language').selectOption('French');
    await confirm();
    check(await p.locator('#nt2-language').inputValue() === 'French', 'Override reaches reply language');
    await p.locator('#nt2-msg').fill('Keep this draft');
    await p.locator('[data-action="nt.back"]').click();
    await confirm();
    check(await p.locator('#nt2-msg').inputValue() === 'Keep this draft', 'Back preserves message without another prompt');
    check(await p.locator('#nt2-language').inputValue() === 'French', 'Back preserves language');
    await p.locator('[data-action="nt.back"]').click();
    await p.locator('[data-action="nt.clearCust"]').click();
    await p.locator('#nt-cust-search').fill('James');
    await p.locator('[data-mousedown-action="nt.pick"]').first().click();
    await confirm();
    check(await p.locator('#nt-language').inputValue() === 'English', 'Different customer needs fresh confirmation');
    await confirm();
    check(await p.locator('#nt2-msg').inputValue() === 'Keep this draft', 'Customer change preserves draft');
    check(await p.locator('#nt2-language').inputValue() === 'English', 'Previous customer language cleared');
    await p.locator('[data-action="nt.cancel"]').click();
  }
  for (const jurisdiction of ['', 'Canada', 'Unknown', '<img src=x onerror=alert(1)>']) {
    await open(jurisdiction);
    check(await p.locator('#nt-language').inputValue() === '', 'No guess for ' + jurisdiction);
    await confirm();
    check(await p.locator('#nt-language-error').isVisible(), 'Manual choice required');
    check(await p.locator('#nt2-msg').count() === 0, 'Validation blocks editor');
    check(await p.locator('#modal-container img').count() === 0, 'Jurisdiction is escaped');
    await p.locator('#nt-language').selectOption('German');
    check(await p.locator('#nt-language-error').isHidden(), 'Choosing a language clears validation error');
    await p.keyboard.press('Escape');
    check(await p.locator('#nt-subj').inputValue() === 'Account update', 'Escape returns with details intact');
    await confirm();
    await p.getByRole('button', {name:'Back', exact:true}).click();
    check(await p.locator('#nt-subj').inputValue() === 'Account update', 'Back returns with details intact');
    await confirm();
    await p.locator('#nt-language').selectOption('German');
    await confirm();
    check(await p.locator('#nt2-language').inputValue() === 'German', 'Manual choice reaches editor');
    await p.locator('[data-action="nt.cancel"]').click();
  }
  check(creates === 0, 'Confirmation and cancellation create no tickets');
  await p.close();
  return {checks};
};
