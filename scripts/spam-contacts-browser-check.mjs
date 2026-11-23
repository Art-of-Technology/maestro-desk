export default async function checkSpamContacts(page) {
  const check = (ok, message) => { if (!ok) throw Error(message); };
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', workspace = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let spam = true, failList = false, failSave = false, saves = 0;
  const row = { id, display_id: 'M118', first_name: 'Alexandra', last_name: 'Montgomery-Williams', email: 'long-email-address@example.test', marked_by: 'Review Agent', marked_at: '2026-11-16T12:00:00Z' };
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/spam-history')) return route.fulfill({ json: { events: [
      ...(!spam ? [{ action: 'customer.spam_unmarked', actor: 'Review Agent', created_at: '2026-11-16T13:00:00Z' }] : []),
      { action: 'customer.spam_marked', actor: 'Review Agent', created_at: row.marked_at },
    ], next_offset: null } });
    if (url.pathname === '/api/v1/customers/spam') {
      if (failList) return route.fulfill({ status: 500, json: { error: 'Unavailable' } });
      const q = url.searchParams.get('q');
      return route.fulfill({ json: { contacts: spam && q !== 'missing' ? [row] : [], next_offset: null } });
    }
    if (url.pathname.endsWith('/spam') && route.request().method() === 'DELETE') {
      saves++; if (failSave) return route.fulfill({ status: 500, json: { error: 'Could not unmark contact' } });
      spam = false; return route.fulfill({ json: { customer: { id, is_spam: false } } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto('http://localhost:5173'); await page.evaluate(() => window.login('Admin', 'Review Agent', 'RA'));
  await page.waitForTimeout(200);
  await page.evaluate(async ({ id, workspace }) => {
    (await import('/js/guides/index.js')).closeGuides();
    const a = await import('/js/core/api-client.js'), d = await import('/js/core/data.js'), s = await import('/js/core/state.js');
    a.setJwt('fixture'); a.setWorkspaceId(workspace); s.setSession({ ...s.SESSION, userId: 'fixture' });
    d.CUSTOMERS[0]._uuid = id; d.CUSTOMERS[0].isSpam = true;
    s.setSettingsTabValue('spam-contacts'); (await import('/js/core/router.js')).nav('settings');
  }, { id, workspace });
  const root = page.locator('[data-spam-contacts]');
  await root.getByText('Alexandra Montgomery-Williams', { exact: true }).waitFor();
  check((await root.locator('a').getAttribute('href')).includes(workspace + '/customers/' + id), 'Profile link is scoped to the contact workspace');
  await root.locator('a').click();
  await page.locator('[data-customer-history]').waitFor();
  await page.evaluate(async () => { (await import('/js/core/router.js')).nav('settings'); });
  await root.locator('.spam-contact-row').waitFor();
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 }); await root.scrollIntoViewIfNeeded();
    check(await root.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'No horizontal overflow at ' + width);
    await page.screenshot({ path: `spam-settings-${width}.png`, fullPage: true });
  }
  await root.getByRole('button', { name: 'View history' }).click();
  await root.getByText('Marked as spam ·', { exact: false }).waitFor();
  const search = root.getByRole('searchbox'); await search.fill('missing'); await search.press('Enter');
  await root.getByText('No matching spam contacts.').waitFor();
  failList = true; await search.fill(''); await search.press('Enter'); await root.getByText('Couldn’t load spam contacts.').waitFor();
  failList = false; await root.getByRole('button', { name: 'Try again' }).click();
  await root.getByRole('button', { name: 'Unmark as spam', exact: true }).click();
  check(saves === 0, 'Opening confirmation does not mutate');
  await page.locator('.modal').getByRole('button', { name: 'Cancel' }).click(); check(saves === 0, 'Cancel does not mutate');
  await root.getByRole('button', { name: 'Unmark as spam', exact: true }).click();
  failSave = true; await page.locator('.modal').getByRole('button', { name: 'Unmark as spam', exact: true }).click();
  await page.getByText('Could not unmark contact', { exact: true }).waitFor();
  check(await root.locator('.spam-contact-row').count() === 1, 'Failed save retains contact');
  failSave = false; await page.locator('.modal').getByRole('button', { name: 'Unmark as spam', exact: true }).click();
  await root.getByText('No contacts are marked as spam.').waitFor();
  await root.getByText('Unmarked as spam ·', { exact: false }).waitFor();
  check(await page.evaluate(async () => !(await import('/js/core/data.js')).CUSTOMERS[0].isSpam), 'Cached profile updated after success');
  await page.evaluate(async () => {
    const s = await import('/js/core/state.js');
    s.setSession({ ...s.SESSION, permissions: { 'customers.view': true, 'customers.spam': false } });
    (await import('/js/core/router.js')).renderPage('settings');
  });
  check(await page.getByRole('button', { name: 'Spam contacts', exact: true }).count() === 0, 'Tab hidden without permission');
  await page.getByText('You do not have access to spam contacts.').waitFor();
  return { checks: 'server list, scoped profile link, responsive layout, keyboard search, history, empty/error/retry, confirmation/cancel, failed and successful unmark, cache update, permissions' };
}
