// Run against the local static server via Playwright. All API traffic is mocked.
export default async function checkTemplatePicker(page) {
  let checks = 0;
  const assert = (ok, message) => { if (!ok) throw new Error(message); checks++; };
  await page.route('**/api/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.goto('http://localhost:5173');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  const id = await page.evaluate(async () => {
    window.login('Admin', 'Template tester', 'TT');
    const data = await import('/js/core/data.js');
    data.CANNED_RESPONSES.splice(0, data.CANNED_RESPONSES.length,
      { id: 'TPL-ONE', name: 'Refund update', category: ' Payments ', text: 'Your refund is processing.', html: '<p><strong>Your refund is processing.</strong></p>' },
      { id: 'TPL-TWO', name: 'Verification <script>', category: 'Account', text: 'Upload your documents.' },
      { id: 'TPL-THREE', name: 'Welcome', category: '', text: 'A welcome message.' },
      { id: 'TPL-TAILOR', name: 'Tailored response', category: 'Account', text: 'Your reference is {reference}.' },
      ...Array.from({ length: 100 }, (_, i) => ({ id: `TPL-EXTRA-${i}`, name: `Long template ${i} ${'name '.repeat(30)}`, category: 'Other', text: 'A long preview '.repeat(30) })));
    const ticket = data.TICKETS[0];
    (await import('/js/tickets/detail.js')).openTicket(ticket.id);
    const composer = await import('/js/tickets/composer.js');
    await composer.mountComposer(ticket.id);
    composer.setText(ticket.id, 'Existing draft');
    return ticket.id;
  });
  const editor = page.locator(`[id="compose-${id}"] .ql-editor`);
  await editor.click();
  await page.keyboard.press('Control+Shift+Space');
  const search = page.getByRole('searchbox', { name: 'Search templates' });
  assert(await search.evaluate(el => el === document.activeElement), 'Shortcut must focus search');
  assert(await page.getByRole('dialog', { name: 'Response templates' }).count() === 1, 'Picker needs dialog semantics');
  assert(await page.locator('.template-result').count() === 104, 'All templates available without a hidden cap');
  await search.fill('  PAYMENTS refund ');
  assert(await page.locator('.template-result').count() === 1, 'Search combines words across category and name');
  await page.getByLabel('Category', { exact: true }).selectOption('Account');
  assert(await page.locator('.template-result').count() === 0, 'Search and category must combine');
  assert((await page.locator('#template-picker-results').innerText()).includes('Try another'), 'No-match state explains recovery');
  await search.fill('documents');
  assert(await page.locator('.template-result').count() === 1, 'Search must match body text');
  assert(await page.locator('#template-picker-results script').count() === 0, 'Template names must be escaped');
  await page.getByLabel('Category', { exact: true }).selectOption('');
  await search.fill('');
  await page.keyboard.press('ArrowDown');
  assert((await page.evaluate(() => document.activeElement.dataset.templateId)) === 'TPL-ONE', 'Down selects first result');
  await page.keyboard.press('ArrowDown');
  assert((await page.evaluate(() => document.activeElement.dataset.templateId)) === 'TPL-TWO', 'Down selects next result');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  assert(await search.evaluate(el => el === document.activeElement), 'Up from first result returns to search');
  await page.keyboard.press('Shift+Tab');
  assert(await page.getByRole('button', { name: 'Close templates' }).evaluate(el => el === document.activeElement), 'Close button is keyboard accessible');
  await page.keyboard.press('Shift+Tab');
  assert((await page.evaluate(() => document.activeElement.dataset.templateId)) === 'TPL-EXTRA-99', 'Tab is trapped inside dialog');
  await page.keyboard.press('Escape');
  assert(await page.locator('.template-picker').count() === 0, 'Escape closes picker');
  assert(await editor.evaluate(el => el === document.activeElement), 'Escape restores composer focus');
  await page.keyboard.press('Meta+Shift+Space');
  assert(await search.evaluate(el => el === document.activeElement), 'Mac shortcut opens search');
  await search.fill('refund');
  // Reordering the live data must not change which template a rendered result inserts.
  await page.evaluate(async () => (await import('/js/core/data.js')).CANNED_RESPONSES.reverse());
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Insert response', exact: true }).click();
  await page.waitForFunction(id => document.getElementById('compose-' + id)?.querySelector('strong'), id);
  assert((await editor.innerText()).startsWith('Existing draft'), 'Insertion preserves draft');
  assert((await editor.innerText()).includes('Your refund is processing.'), 'Filtered selection uses stable template identity');
  assert(await editor.locator('strong').count() === 1, 'Insertion preserves formatting');
  await page.getByRole('button', { name: 'Insert template', exact: true }).click();
  await search.fill('tailored');
  await page.keyboard.press('Enter');
  assert((await page.locator('#modal-container').innerText()).includes('reference'), 'Unfilled variables still require tailoring');
  assert(!(await editor.innerText()).includes('{reference}'), 'Unfilled variables cannot enter draft');
  await page.evaluate(async () => (await import('/js/core/modal.js')).closeModal());

  const layouts = [];
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('button', { name: 'Insert template', exact: true }).click();
    const layout = await page.locator('.template-picker').evaluate(el => {
      const rect = el.getBoundingClientRect();
      const results = el.querySelector('#template-picker-results');
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, overflow: el.scrollWidth > el.clientWidth, scrollable: results.scrollHeight > results.clientHeight };
    });
    assert(layout.left >= 0 && layout.right <= width && layout.top >= 0 && layout.bottom <= 900 && !layout.overflow, `Picker fits ${width}px viewport`);
    assert(layout.scrollable, 'Long list scrolls independently of filters');
    layouts.push({ width, ...layout });
    await page.screenshot({ path: `template-picker-${width}.png` });
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(async () => {
    (await import('/js/core/modal.js')).showModal('Unrelated dialog', '<input id="unrelated-input" aria-label="Unrelated input">', null);
    document.getElementById('unrelated-input').focus();
  });
  await page.locator('#modal-container .modal-close').dispatchEvent('click');
  assert(await page.evaluate(() => !document.activeElement.closest('[id^="compose-"]') && document.activeElement.dataset.action !== 'td.macroPanel'), 'Closed pickers must not steal focus when an unrelated modal closes');
  await page.evaluate(async () => (await import('/js/core/router.js')).nav('templates'));
  await page.getByLabel('Category', { exact: true }).selectOption('Uncategorised');
  assert(await page.getByLabel('Category', { exact: true }).evaluate(el => el === document.activeElement), 'Library category retains focus after filtering');
  assert(await page.locator('.tbl tbody tr').count() === 1, 'Library can filter uncategorised templates');
  await page.getByLabel('Category', { exact: true }).selectOption('');
  await page.getByRole('searchbox', { name: 'Search templates' }).fill('  refund payments ');
  assert(await page.locator('.tbl tbody tr').count() === 1, 'Library shares picker search behaviour');
  await page.getByRole('searchbox', { name: 'Search templates' }).press('Home');
  await page.keyboard.type('x');
  assert(await page.getByRole('searchbox', { name: 'Search templates' }).evaluate(el => el.selectionStart) === 1, 'Library search preserves cursor while rerendering');
  await page.evaluate(async () => {
    (await import('/js/core/data.js')).CANNED_RESPONSES.length = 0;
    (await import('/js/tickets/macros.js')).showMacroPanel('missing-ticket');
  });
  assert((await page.locator('#template-picker-results').innerText()).includes('Ask an admin'), 'Empty library gives a next step');
  await page.keyboard.press('Enter');
  assert(await page.locator('.template-picker').count() === 1, 'Enter with no results does nothing');
  await page.keyboard.press('Escape');
  return { checks, layouts };
}
