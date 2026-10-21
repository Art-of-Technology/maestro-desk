// Local fixtures only. Separate browser contexts stand in for two agents/devices.
export default async page => {
  const contexts = [], writes = [];
  let checks = 0, fail = false, hold, release;
  const check = (ok, message) => { checks++; if (!ok) throw Error(message); };
  const id = '11111111-1111-4111-8111-111111111111';
  const customer = {id, display_id:'M001', first_name:'Sarah', last_name:'Mitchell', jurisdiction:'CL', preferred_language:'French', email:'fixture@example.test'};
  async function agent(name) {
    const context = await page.context().browser().newContext(); contexts.push(context);
    const p = await context.newPage();
    await p.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let json = {}, status = 200;
      if (path.endsWith('/ticket-statuses')) json = {statuses:['open','pending','escalated','gdpr','resolved','closed'].map(key => ({key,label:key,base_key:key,is_active:true,send_survey:false}))};
      if (path.endsWith('/customers')) json = {customers:[customer]};
      if (path.endsWith('/customers/'+id) && route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON(); writes.push(body);
        if (hold) await hold;
        if (fail) { status = 503; json = {error:'Fixture unavailable'}; }
        else { Object.assign(customer, body); json = {customer}; }
      }
      await route.fulfill({status,json});
    });
    await p.goto('http://localhost:5173');
    await p.waitForFunction(() => typeof window.login === 'function');
    await p.evaluate(async name => {
      window.login('Admin', name, 'LT', {userId:name});
      const api = await import('/js/core/api-client.js');
      api.setJwt(name); api.setWorkspaceId('33333333-3333-4333-8333-333333333333');
      const {CUSTOMERS,CATEGORIES} = await import('/js/core/data.js');
      if (!CATEGORIES.length) CATEGORIES.push({key:'general',label:'General',is_active:true});
      const {applyCustomerRow} = await import('/js/core/bootstrap.js');
      const data = await api.apiGet('/api/v1/customers');
      CUSTOMERS[0]._uuid = data.customers[0].id;
      applyCustomerRow(CUSTOMERS[0], data.customers[0]);
    }, name);
    return p;
  }
  const confirm = p => p.locator('[data-action="modal.confirm"]').click();
  const open = async p => {
    await p.evaluate(async () => { await (await import('/js/tickets/new-ticket.js')).showNewTicketModal(null,'M001'); });
    await p.locator('#nt-subj').fill('Language fixture');
    await p.locator('#nt-cat').selectOption({index:1});
    await confirm(p);
  };
  const p = await agent('first-agent');
  await open(p);
  check(await p.locator('#nt-language').inputValue() === 'French', 'Saved language beats Chile suggestion');
  check((await p.locator('.modal-body').innerText()).includes('Saved preferred language: French'), 'Saved preference is explained');
  await p.locator('#nt-language').selectOption('German');
  hold = new Promise(resolve => { release = resolve; });
  await confirm(p);
  await p.waitForFunction(() => document.querySelector('[data-action="modal.confirm"]').disabled);
  check(await p.getByRole('button',{name:'Back',exact:true}).isDisabled(), 'Cannot go back during save');
  await p.keyboard.press('Escape');
  check(await p.locator('#nt-language').count() === 1, 'Cannot escape during save');
  release(); hold = null;
  await p.locator('#nt2-msg').waitFor();
  check(customer.preferred_language === 'German' && writes.length === 1, 'Confirmation saves once');
  check(await p.locator('#nt2-language').inputValue() === 'German', 'Saved choice reaches editor');
  await p.locator('[data-action="nt.cancel"]').click();
  const other = await agent('second-agent');
  await other.setViewportSize({width:390,height:900});
  await open(other);
  check(await other.locator('#nt-language').inputValue() === 'German', 'Other agent/device reads saved preference');
  fail = true;
  await other.locator('#nt-language').selectOption('Italian');
  await confirm(other);
  await other.locator('#nt-language-error').waitFor({state:'visible'});
  check(await other.locator('#nt2-msg').count() === 0, 'Save failure blocks editor');
  check(await other.locator('#nt-language').inputValue() === 'Italian', 'Failed choice is kept for retry');
  check(customer.preferred_language === 'German', 'Failed save does not overwrite preference');
  fail = false; await confirm(other);
  await other.locator('#nt2-msg').waitFor();
  check(customer.preferred_language === 'Italian', 'Retry saves successfully');
  await other.locator('[data-action="nt.cancel"]').click();
  await other.evaluate(async () => (await import('/js/customers/details-card.js')).showEditDetailsModal('M001'));
  check(await other.locator('#ed-preferredLanguage').inputValue() === 'Italian', 'Profile editor shows current preference');
  await other.locator('#ed-preferredLanguage').selectOption('');
  await confirm(other); await confirm(other);
  await other.locator('#ed-preferredLanguage').waitFor({state:'detached'});
  check(customer.preferred_language === null, 'Profile can clear preference');
  await open(other);
  check(await other.locator('#nt-language').inputValue() === 'Spanish', 'Cleared preference falls back to jurisdiction');
  check(await other.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Popup fits phone width');
  await other.screenshot({path:'customer-language-390.png'});
  await other.getByRole('button',{name:'Cancel new conversation'}).click();
  const before = writes.length;
  await open(other); await other.getByRole('button',{name:'Back',exact:true}).click();
  check(writes.length === before, 'Backing out before confirmation writes nothing');
  await confirm(other);
  hold = new Promise(resolve => { release = resolve; });
  await confirm(other);
  await other.waitForFunction(() => document.querySelector('[data-action="modal.confirm"]').disabled);
  await other.evaluate(async () => { (await import('/js/core/api-client.js')).setWorkspaceId('44444444-4444-4444-8444-444444444444'); });
  release(); hold = null;
  await other.waitForTimeout(100);
  check(await other.locator('#nt2-msg').count() === 0, 'Late save cannot advance another workspace');
  for (const context of contexts) await context.close();
  return {checks};
};
