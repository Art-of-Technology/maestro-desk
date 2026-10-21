// Run against the local static server via Playwright. All API traffic is mocked.
export default async function checkTemplateFavourites(page) {
  let checks = 0, writes = 0, failWrite = false, failRead = false;
  const assert = (ok, message) => { if (!ok) throw new Error(message); checks++; };
  const first = '10000000-0000-4000-8000-000000000001', second = '10000000-0000-4000-8000-000000000002';
  const server = new Map([['fixture-a|workspace-a', new Set([first])]]);
  await page.route('**/api/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/v1/me/template-favourites**', async route => {
    const req = route.request(), headers = req.headers();
    const key = `${headers.authorization?.replace('Bearer ', '')}|${headers['x-workspace-id']}`;
    const pins = server.get(key) || new Set();
    if (req.method() === 'GET') {
      await route.fulfill({ status: failRead ? 503 : 200, contentType: 'application/json', body: JSON.stringify(failRead ? { error: 'Unavailable' } : { favourites: [...pins] }) });
    } else {
      writes++;
      const id = req.url().split('/').at(-1), { pinned } = req.postDataJSON();
      if (!failWrite) { if (pinned) pins.add(id); else pins.delete(id); server.set(key, pins); }
      await route.fulfill({ status: failWrite ? 503 : 200, contentType: 'application/json', body: JSON.stringify(failWrite ? { error: 'Unavailable' } : { template_id: id, pinned }) });
    }
  });
  await page.goto('http://localhost:5173');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  const initialise = async () => page.evaluate(async ({ first, second }) => {
    window.login('Agent', 'Favourite tester', 'FT');
    const { SESSION } = await import('/js/core/state.js'); SESSION.userId = 'fixture-agent-a';
    const api = await import('/js/core/api-client.js'); api.setJwt('fixture-a'); api.setWorkspaceId('workspace-a');
    const data = await import('/js/core/data.js');
    data.CANNED_RESPONSES.splice(0, data.CANNED_RESPONSES.length,
      { _uuid: first, id: 'TPL-ONE', name: 'Refund update', category: 'Payments', text: 'Your refund is processing.', html: '<p><strong>Your refund is processing.</strong></p>' },
      { _uuid: second, id: 'TPL-TWO', name: 'Verification', category: 'Account', text: 'Upload your documents.' });
    const id = data.TICKETS[0].id;
    (await import('/js/tickets/detail.js')).openTicket(id);
    await (await import('/js/tickets/composer.js')).mountComposer(id);
    (await import('/js/tickets/layout.js')).setComposerMode(id, 'edit');
    return id;
  }, { first, second });
  const id = await initialise();
  const strip = page.locator('.template-favourites-links');
  await page.waitForSelector('.template-favourites-links button');
  assert((await strip.innerText()).includes('Refund update'), 'Saved favourite appears above composer');
  const editor = page.locator(`[id="compose-${id}"] .ql-editor`);
  await page.evaluate(async id => (await import('/js/tickets/composer.js')).setText(id, 'Existing draft'), id);
  await strip.getByRole('button', { name: 'Refund update', exact: true }).click();
  await page.getByRole('button', { name: 'Insert response', exact: true }).click();
  assert((await editor.innerText()).startsWith('Existing draft'), 'Quick access preserves existing draft');
  assert(await editor.locator('strong').count() === 1, 'Quick access preserves formatting and uses preview confirmation');
  await page.getByRole('button', { name: 'Insert template', exact: true }).click();
  await page.getByRole('button', { name: 'Pin Verification', exact: true }).click();
  await page.waitForSelector('.template-pin[aria-label="Unpin Verification"]:not(:disabled)');
  assert(server.get('fixture-a|workspace-a').has(second), 'Pin persists to current account and workspace');
  assert((await strip.innerText()).includes('Verification'), 'New pin appears without reopening ticket');
  assert(await page.locator('.template-result').first().getAttribute('data-template-id') === first, 'Pinned results retain library order');
  await page.getByRole('button', { name: 'Unpin Refund update', exact: true }).click();
  await page.waitForSelector('.template-pin[aria-label="Pin Refund update"]:not(:disabled)');
  assert(await page.locator('.template-result').first().getAttribute('data-template-id') === second, 'Pinned responses come first');
  assert(!(await strip.innerText()).includes('Refund update'), 'Unpin removes quick access');
  await page.getByRole('searchbox', { name: 'Search templates' }).fill('refund');
  assert(await page.locator('.template-result').count() === 1, 'Search still applies when favourites exist');
  await page.getByRole('button', { name: 'Close templates' }).click();
  failWrite = true;
  await page.evaluate(async () => (await import('/js/core/router.js')).nav('templates'));
  assert(await page.getByRole('button', { name: 'Edit', exact: true }).count() === 0, 'Non-admin can use library without editing templates');
  await page.getByRole('button', { name: 'Pin Refund update', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.template-library-page')?.textContent.includes('Couldn’t save'));
  assert(!server.get('fixture-a|workspace-a').has(first), 'Failed save does not pretend to be pinned');
  assert(await page.getByRole('button', { name: 'Pin Refund update', exact: true }).count() === 1, 'Failed pin remains retryable');
  failWrite = false;
  await page.getByRole('button', { name: 'Pin Refund update', exact: true }).click();
  await page.waitForSelector('.template-pin[aria-label="Unpin Refund update"]:not(:disabled)');
  assert(server.get('fixture-a|workspace-a').has(first), 'Retry saves successfully');
  assert(await page.getByRole('button', { name: 'Unpin Refund update', exact: true }).evaluate(el => document.activeElement === el), 'Pin retains keyboard focus across saving');

  await page.evaluate(() => sessionStorage.clear());
  await page.reload(); await initialise();
  await page.waitForSelector('.template-favourites-links button');
  assert(await strip.locator('button').count() === 2, 'Server favourites survive a fresh page session');
  await strip.getByRole('button', { name: 'Refund update', exact: true }).focus();
  await page.evaluate(async () => (await import('/js/tickets/template-favourites.js')).loadTemplateFavourites());
  assert(await strip.getByRole('button', { name: 'Refund update', exact: true }).evaluate(el => document.activeElement === el), 'Refreshing favourites preserves focus on a composer shortcut');
  server.get('fixture-a|workspace-a').delete(first);
  await page.evaluate(async () => (await import('/js/tickets/template-favourites.js')).loadTemplateFavourites());
  assert(await page.getByRole('button', { name: 'Insert template', exact: true }).evaluate(el => document.activeElement === el), 'A remotely removed favourite returns focus to the template picker button');
  server.get('fixture-a|workspace-a').add(first);
  await page.evaluate(async () => (await import('/js/tickets/template-favourites.js')).loadTemplateFavourites());
  await page.locator('[data-action="td.setComposeTab"][data-tab="note"]').last().click();
  assert(await page.locator('.template-favourites').count() === 0, 'Reply favourites are hidden on internal notes');
  await page.locator('[data-action="td.setComposeTab"][data-tab="reply"]').last().click();
  assert(await strip.locator('button').count() === 2, 'Returning to Reply restores favourites');
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const fit = await strip.evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && el.clientWidth > 0; });
    assert(fit, `Favourites strip fits ${width}px viewport`);
    await page.screenshot({ path: `template-favourites-${width}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(async () => {
    const { setWorkspaceId } = await import('/js/core/api-client.js'); setWorkspaceId('workspace-b');
    const { TICKETS } = await import('/js/core/data.js'); (await import('/js/tickets/detail.js')).openTicket(TICKETS[0].id);
  });
  await page.waitForFunction(() => !document.querySelector('.template-favourites')?.textContent.includes('Loading favourites'));
  assert(await strip.locator('button').count() === 0, 'Another workspace cannot see original pins');
  failRead = true;
  await page.evaluate(async () => {
    const api = await import('/js/core/api-client.js'); api.setJwt('fixture-b'); api.setWorkspaceId('workspace-a');
    (await import('/js/core/state.js')).SESSION.userId = 'fixture-agent-b';
    const { TICKETS } = await import('/js/core/data.js'); (await import('/js/tickets/detail.js')).openTicket(TICKETS[0].id);
  });
  await page.waitForSelector('[data-action="templateFavourites.retry"]');
  assert(await strip.locator('button').count() === 0, 'Load failure does not expose previous account pins');
  failRead = false;
  await page.getByRole('button', { name: 'Retry favourites' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-action="templateFavourites.retry"]') && !document.querySelector('.template-favourites')?.textContent.includes('Loading favourites'));
  assert(await strip.locator('button').count() === 0, 'Different account starts with its own empty pins');
  assert(writes === 4, 'Only the four explicit pin actions may write preferences');
  return { checks, writes };
}
