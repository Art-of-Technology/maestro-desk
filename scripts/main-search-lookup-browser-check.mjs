// Synthetic lookup responses only; no customer records or messages are created.
export default async function checkMainSearchLookup(browser) {
  let checks = 0;
  const check = (ok, message) => { checks++; if (!ok) throw Error(message); };
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(), calls = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let status = 200;
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/maestro/players')) {
        calls.push({ query: url.searchParams.get('email'), brand: route.request().headers()['x-brand-id'] });
        return route.fulfill({ status, json: status === 200 ? { member: { email: 'lookup@example.test', firstName: 'Lookup', lastName: 'Fixture' } } : { error: status === 404 ? 'Player not found' : 'Lookup unavailable' } });
      }
      await route.fulfill({ json: {} });
    });
    try {
      await page.goto('http://localhost:5173');
      await page.waitForFunction(() => typeof window.login === 'function');
      await page.evaluate(async () => {
        window.login('Admin', 'Lookup tester', 'LT');
        const api = await import('/js/core/api-client.js');
        api.setJwt('fixture'); api.setWorkspaceId('fixture-workspace'); api.setBrandId('fixture-brand');
        const { CUSTOMERS, TICKETS } = await import('/js/core/data.js');
        TICKETS.length = 0;
        CUSTOMERS.splice(0, CUSTOMERS.length, { id: 'C-FIXTURE', first: 'Existing', last: 'Fixture', username: 'existing', email: 'existing@example.test', brand: 'Fixture', vip: 'None' });
      });
      const search = page.locator('#gs-input'), lookup = page.locator('#gs-results [data-action="gs.lookup"]');
      await search.fill('existing@example.test');
      check(await lookup.count() === 0, 'Existing contact hides lookup');
      await search.fill('   ');
      check(await lookup.count() === 0, 'Blank query hides lookup');
      for (const mode of ['mouse', 'arrows', 'tab', 'results']) {
        status = mode === 'arrows' ? 404 : mode === 'tab' ? 503 : 200;
        const query = mode === 'mouse' ? 'MixedCase+tag@example.test' : `missing-${mode}@example.test`;
        await search.fill(`  ${query}  `);
        await lookup.waitFor({ state: 'visible' });
        const before = calls.length;
        const response = page.waitForResponse(r => r.url().includes('/maestro/players?'));
        if (mode === 'mouse') await lookup.click();
        if (mode === 'arrows') { await search.press('ArrowDown'); await search.press('Enter'); }
        if (mode === 'tab') { await lookup.focus(); await page.keyboard.press('Enter'); }
        if (mode === 'results') {
          await search.press('Enter');
          await page.locator('.filter-bar [data-action="gs.lookup"]').click();
        }
        await response;
        await page.waitForFunction(() => !document.querySelector('.page-scroll')?.textContent.includes('Looking up '));
        check(calls.length === before + 1, `${mode}: lookup sent once`);
        check(calls.at(-1).query === query && calls.at(-1).brand === 'fixture-brand', `${mode}: query and selected brand preserved`);
        check(await page.locator('#player-lookup-input').inputValue() === query, `${mode}: input preserved`);
        check(await search.inputValue() === '' && !await page.locator('#gs-results').isVisible(), `${mode}: dropdown dismissed`);
        if (status !== 200) {
          await page.getByText(status === 404 ? 'No player found for that email or username' : 'Lookup unavailable', { exact: true }).waitFor();
          check(true, 'Lookup error remains visible');
        }
      }
      await page.evaluate(async () => (await import('/js/core/api-client.js')).setBrandId(null));
      await search.fill('unknown@example.test');
      check(await lookup.count() === 0, 'Missing brand hides lookup');
      check(errors.length === 0, `No browser exceptions: ${errors.join(', ')}`);
    } finally { await context.close(); }
  }
  return { checks };
}
