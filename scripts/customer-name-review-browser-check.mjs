export default async function checkNameReview(page) {
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const customerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const names = { account_holder_name: 'Alexandra Montgomery-Williams', entries: [{
    email: 'player@example.test', sender_name: 'Alex Williams', mismatch: true, review_key: 'a'.repeat(64), reviewed: null,
  }] };
  let saves = 0, fail = false;
  await page.route('**/api/**', async route => {
    const url = route.request().url();
    if (url.endsWith('/summary')) return route.fulfill({ json: {
      totals: { tickets: 0, csat_count: 0, csat_avg: null }, by_status: {}, activity: [],
      tickets: { rows: [], total: 0, limit: 25, offset: 0 }, email_names: names,
    } });
    if (url.endsWith('/name-review')) {
      saves++;
      if (fail) return route.fulfill({ status: 500, json: { error: 'Could not save review' } });
      const body = route.request().postDataJSON();
      check(body.review_key === names.entries[0].review_key, 'Review uses the displayed name pair');
      check(body.reason.trim(), 'Reason is required');
      names.entries[0].reviewed = { by: 'Review Agent', at: '2026-11-16T12:00:00Z', reason: body.reason };
      return route.fulfill({ json: { email_names: names } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto('http://localhost:5173');
  await page.evaluate(() => window.login('Admin', 'Review Agent', 'RA'));
  await page.waitForTimeout(200);
  await page.evaluate(async id => {
    (await import('/js/guides/index.js')).closeGuides();
    const d = await import('/js/core/data.js'), s = await import('/js/core/state.js'), a = await import('/js/core/api-client.js');
    s.setSession({ ...s.SESSION, userId: 'fixture-agent' }); a.setJwt('fixture'); a.setWorkspaceId('fixture');
    const c = d.CUSTOMERS[0]; Object.assign(c, { _uuid: id, first: 'Alexandra', last: 'Montgomery-Williams' });
    d.TICKETS.length = 0; s.setCustomerSelected(c.id);
    (await import('/js/core/router.js')).nav('customers');
  }, customerId);
  const card = page.locator('[data-history-email-names]');
  await card.getByText('Alex Williams', { exact: false }).waitFor();
  check(await card.locator('.contact-name-warning').count() === 1, 'Fresh profile shows mismatch');
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 }); await card.scrollIntoViewIfNeeded();
    check(await card.evaluate(el => el.scrollWidth <= el.clientWidth), 'Name card has no horizontal overflow');
    await page.screenshot({ path: `name-review-${width}.png` });
  }
  await card.getByRole('button', { name: 'Mark as reviewed' }).click();
  await page.locator('#modal-container [data-action="modal.confirm"]').click();
  check(saves === 0, 'Blank reason does not send request');
  await page.locator('#name-review-reason').fill('Middle name checked against account evidence');
  await page.locator('#modal-container [data-action="modal.confirm"]').click();
  await card.getByText('Reviewed by Review Agent', { exact: false }).waitFor();
  check(await card.locator('.contact-name-warning').count() === 0, 'Accepted pair has no warning');
  check((await card.textContent()).includes('Alex Williams') && (await card.textContent()).includes('Alexandra Montgomery-Williams'), 'Both names remain');
  const reload = async () => { await page.evaluate(async () => (await import('/js/core/router.js')).renderPage('customers')); await card.getByText('Alex Williams', { exact: false }).waitFor(); };
  await reload();
  check(await card.locator('.contact-name-reviewed').count() === 1, 'Review persists after profile reload');
  names.account_holder_name = 'Alexandra Williams'; names.entries[0].review_key = 'b'.repeat(64); names.entries[0].reviewed = null;
  await reload();
  check(await card.locator('.contact-name-warning').count() === 1, 'Changed name restores warning');
  fail = true;
  await card.getByRole('button', { name: 'Mark as reviewed' }).click();
  await page.locator('#name-review-reason').fill('Checking failure state');
  await page.locator('#modal-container [data-action="modal.confirm"]').click();
  await page.getByText('Could not save review', { exact: true }).waitFor();
  check(await card.locator('.contact-name-warning').count() === 1, 'Failed save keeps warning');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(async () => { const s = await import('/js/core/state.js'); s.setSession({ ...s.SESSION, permissions: { 'customers.view': true, 'tickets.view_all': true, 'customers.edit': false } }); });
  await reload();
  check(await card.getByRole('button', { name: 'Mark as reviewed' }).count() === 0, 'Read-only agent cannot review');
  return { checks: 'fresh names, responsive card, reason required, accepted warning hidden, names preserved, persistent review, changed name rewarns, failure retry, permissions' };
}
