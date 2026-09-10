export default async function checkCustomerCreate(page) {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  await page.route('**/api/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.goto('http://localhost:5173');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.evaluate(async () => {
    window.login('Admin', 'Customer tester', 'CT');
    (await import('/js/core/data.js')).CUSTOMERS.length = 0;
    sessionStorage.setItem('maestro_jwt', 'fixture-only');
    sessionStorage.setItem('maestro_workspace_id', 'fixture-workspace');
    (await import('/js/core/router.js')).nav('customers');
  });
  let posts = 0;
  let fail = false;
  let release;
  let requestStarted;
  let received;
  await page.route('**/api/v1/customers', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ status: 200, body: '{}' });
    posts++;
    received = route.request().postDataJSON();
    if (requestStarted) requestStarted();
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ status: fail ? 409 : 201, contentType: 'application/json', body: JSON.stringify(fail
      ? { error: 'That email already belongs to a customer in this workspace.' }
      : { customer: { id: 'customer-fixture-' + posts, display_id: 'M-' + posts, ...received, consent: false, emails: [], mobiles: [] } }) });
  });
  const open = async () => {
    await page.evaluate(async () => (await import('/js/customers/modals.js')).showNewCustomerModal());
    await page.locator('#nc-first').fill('Acceptance');
    await page.locator('#nc-last').fill('Customer');
    await page.locator('#nc-email').fill('customer@example.test');
  };
  await open();
  let started = new Promise(resolve => { requestStarted = resolve; });
  await page.locator('[data-action="modal.confirm"]').dispatchEvent('click');
  await started;
  await page.locator('[data-action="modal.confirm"]').dispatchEvent('click');
  assert(posts === 1, 'Double click must not duplicate the request');
  release();
  await page.waitForSelector('#nc-first', { state: 'detached' });
  const saved = await page.evaluate(async () => (await import('/js/core/data.js')).CUSTOMERS[0]);
  assert(saved._uuid === 'customer-fixture-1' && saved.id === 'M-1', 'Use server identity, never a local ghost');
  assert(saved.consent === false && !('consent' in received), 'Do not infer or submit marketing consent');

  fail = true;
  await open();
  started = new Promise(resolve => { requestStarted = resolve; });
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await started;
  release();
  await page.waitForFunction(() => document.getElementById('nc-error')?.textContent.includes('already belongs'));
  assert(await page.locator('#nc-email').inputValue() === 'customer@example.test', 'Save failure must preserve form data');
  assert(await page.getByRole('button', { name: 'Create', exact: true }).isEnabled(), 'Save failure must allow retry');

  fail = false;
  started = new Promise(resolve => { requestStarted = resolve; });
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await started;
  await page.evaluate(() => sessionStorage.setItem('maestro_workspace_id', 'other-workspace'));
  release();
  await page.waitForFunction(() => !document.querySelector('[data-action="modal.confirm"]').disabled);
  const count = await page.evaluate(async () => (await import('/js/core/data.js')).CUSTOMERS.length);
  assert(count === 1, 'Late response must not add a customer to a different workspace');
  return { posts, checks: 'server persistence path, empty workspace, double click, consent, duplicate error, form preservation, workspace drift' };
}
