// Run against the local static server via Playwright. All API traffic is mocked.
export default async function checkNewTicketTemplates(page) {
  let checks = 0, writes = 0;
  page.on('dialog', dialog => dialog.accept());
  const assert = (ok, message) => { if (!ok) throw new Error(message); checks++; };
  await page.route('**/api/**', route => {
    if (!['GET', 'OPTIONS'].includes(route.request().method())) writes++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto('http://localhost:5173');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  const customerId = await page.evaluate(async () => {
    window.login('Admin', 'Starter template tester', 'ST');
    const data = await import('/js/core/data.js');
    data.TICKET_TEMPLATES.splice(0, data.TICKET_TEMPLATES.length,
      { id: 'TT-REFUND', name: 'Refund update', category: ' Payments ', subject: 'Withdrawal status', body: 'Your bank transfer is pending.', priority: 'high' },
      { id: 'TT-ACCOUNT', name: 'Account <script>', category: 'Account', subject: 'Verification request', body: 'Please upload proof of address.', priority: 'normal' },
      { id: 'TT-EMPTY', name: 'Welcome', category: '', subject: 'Welcome aboard', body: 'Hello and welcome.', priority: 'normal' },
      ...Array.from({ length: 100 }, (_, i) => ({ id: `TT-LONG-${i}`, name: `Long starter ${i} ${'template '.repeat(20)}`, category: 'Other', subject: 'Other request', body: 'Other wording.' })));
    data.CATEGORIES.splice(0, data.CATEGORIES.length,
      { key: 'payments', label: 'Payments', is_active: true }, { key: 'account', label: 'Account', is_active: true });
    await (await import('/js/tickets/new-ticket.js')).showNewTicketModal(null, data.CUSTOMERS[0].id);
    return data.CUSTOMERS[0].id;
  });
  const search = page.getByRole('searchbox', { name: 'Search templates', exact: true });
  const category = page.getByRole('combobox', { name: 'Template category', exact: true });
  const starter = page.getByRole('combobox', { name: 'Start from ticket template (optional)', exact: true });
  assert(await starter.locator('option').count() === 104, 'All 103 templates and blank choice are initially available');
  await page.locator('#nt-subj').fill('Keep my subject');
  await page.locator('#nt-cat').selectOption('account');
  await page.locator('#nt-pri').selectOption('urgent');
  await search.fill('  WITHDRAWAL transfer ');
  assert(await starter.locator('option').count() === 2, 'Search combines subject and message words, ignoring spaces and case');
  assert(await starter.inputValue() === '', 'Filtering must not select a template automatically');
  assert(await page.locator('#nt-subj').inputValue() === 'Keep my subject', 'Filtering preserves typed subject');
  assert(await page.locator('#nt-cat').inputValue() === 'account', 'Template search does not change ticket category');
  assert(await page.locator('#nt-pri').inputValue() === 'urgent', 'Filtering preserves priority');
  await starter.selectOption('TT-REFUND');
  assert(await page.locator('#nt-subj').inputValue() === 'Withdrawal status', 'Explicit selection still applies template details');
  assert(await page.locator('#nt-cat').inputValue() === 'payments', 'Template category matches ticket key');
  assert(await page.locator('#nt-pri').inputValue() === 'high', 'Explicit selection still applies template priority');
  await page.locator('#nt-subj').fill('Custom subject');
  await category.selectOption('Account');
  assert(await starter.inputValue() === 'TT-REFUND', 'Current selection survives being filtered out');
  assert(await starter.locator('optgroup').getAttribute('label') === 'Current selection (outside filters)', 'Retained selection is explained');
  assert((await page.locator('#nt-template-count').innerText()).includes('0 of 103'), 'Count excludes a retained non-matching selection');
  assert((await page.locator('#nt-template-count').innerText()).includes('No templates match'), 'No-match state explains recovery');
  assert(await page.locator('#nt-subj').inputValue() === 'Custom subject', 'Filtering cannot reapply a template over edits');
  assert(await page.locator('#nt-cat').inputValue() === 'payments', 'Template category filter is separate from ticket category');
  await search.fill('proof');
  assert(await starter.locator('option').count() === 3, 'Results include blank, retained selection and matching response');
  assert(await starter.locator('script').count() === 0, 'Template names remain escaped');
  await category.selectOption('Uncategorised');
  await search.fill('');
  assert((await page.locator('#nt-template-count').innerText()).includes('1 of 103'), 'Uncategorised templates are searchable');
  assert(await starter.inputValue() === 'TT-REFUND', 'Repeated filtering retains the selected starter');
  await page.locator('#compose-new-ticket .ql-editor').waitFor();
  assert(await page.locator('#nt2-msg').inputValue() === 'Your bank transfer is pending.', 'Starter message survives filter changes');
  await page.locator('#compose-new-ticket .ql-editor').fill('Existing first-message draft');
  await page.locator('#nt2-after-send').selectOption('pending');
  await page.locator('#compose-new-ticket .ql-editor').waitFor();
  assert(await search.inputValue() === '' && await category.inputValue() === 'Uncategorised', 'Filters survive composer rerender');
  assert(await starter.inputValue() === 'TT-REFUND', 'Selected starter survives composer rerender');
  assert(await page.locator('#nt-subj').inputValue() === 'Custom subject', 'Subject edits survive composer rerender');
  await search.fill('verification'); await category.selectOption('Account');
  await starter.selectOption('TT-ACCOUNT');
  assert(await page.locator('#nt2-msg').inputValue() === 'Existing first-message draft', 'Applying a starter keeps an agent-written message');
  await category.selectOption(''); await search.fill('');
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert(await page.locator('.nt-template-controls').evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && el.scrollWidth <= el.clientWidth; }), `Filters fit ${width}px viewport`);
    await page.screenshot({ path: `new-ticket-templates-${width}.png` });
  }
  await search.focus(); await page.keyboard.press('Tab');
  assert(await category.evaluate(el => el === document.activeElement), 'Category is next in keyboard order');
  await page.keyboard.press('Tab');
  assert(await starter.evaluate(el => el === document.activeElement), 'Template selector follows category in keyboard order');
  await page.getByRole('button', { name: 'Close new ticket', exact: true }).click();
  await page.evaluate(async customerId => (await import('/js/tickets/new-ticket.js')).showNewTicketModal(null, customerId), customerId);
  assert(await search.inputValue() === '' && await category.inputValue() === '', 'A fresh conversation resets filters');
  assert(await starter.inputValue() === '', 'A fresh conversation starts blank');
  await page.getByRole('button', { name: 'Close new ticket', exact: true }).click();
  await page.evaluate(async customerId => {
    (await import('/js/core/data.js')).TICKET_TEMPLATES.length = 0;
    await (await import('/js/tickets/new-ticket.js')).showNewTicketModal(null, customerId);
  }, customerId);
  assert(await page.locator('.nt-template-controls').count() === 0, 'Empty template library leaves the normal blank-ticket flow');
  assert(writes === 0, 'Searching, selecting, navigating and cancelling create no ticket or message');
  return { checks, writes };
}
