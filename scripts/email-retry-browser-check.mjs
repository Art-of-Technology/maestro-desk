// Local synthetic fixture, following the email-details browser check.
export default async function checkEmailRetry(page) {
  await page.route('**/api/**', route => route.fulfill({json:{}}));
  await page.goto('http://localhost:5173');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.evaluate(async () => {
    window.login('Admin','Retry tester','RT');
    (await import('/js/guides/index.js')).closeGuides(false);
    const {TICKETS} = await import('/js/core/data.js');
    const t = TICKETS[0];
    Object.assign(t,{_uuid:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',_detailLoaded:true,
      msgs:[{_uuid:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',from:'Agent',r:'agent',t:'Original answer',
        createdAt:'2026-10-16T12:00:00Z',email:{status:'saved',delivery_state:'failed',from:'support@example.test',to:['customer@example.test'],cc:[]}}]});
    sessionStorage.setItem('maestro_jwt','fixture-session');
    sessionStorage.setItem('maestro_workspace_id','cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    window.retryFixtureId = t.id;
    (await import('/js/tickets/detail.js')).openTicket(t.id);
  });
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/messages/*/retry', async route => {
    calls++;
    await gate;
    await route.fulfill({json:{delivery:{emailed:true},email_metadata:{status:'sent',delivery_state:'sent',from:'support@example.test',to:['customer@example.test'],cc:[],sent_at:'2026-10-16T12:05:00Z'}}});
  });
  const button = page.getByRole('button',{name:'Retry sending',exact:true});
  await button.waitFor();
  for (const size of [{width:1280,height:900},{width:390,height:844}]) {
    await page.setViewportSize(size);
    if (!await button.isVisible()) throw Error('Retry action is not visible');
    const bounds = await button.boundingBox();
    if (bounds.x < 0 || bounds.x + bounds.width > size.width) throw Error('Retry action overflows the viewport');
  }
  await button.click();
  await page.getByRole('button',{name:'Sending…',exact:true}).waitFor();
  if (!await page.getByRole('button',{name:'Sending…',exact:true}).isDisabled()) throw Error('Retry button allows another click while sending');
  release();
  await page.waitForFunction(() => !document.querySelector('[data-action="emailRetry.send"]'));
  const result = await page.evaluate(async () => {
    const {TICKETS} = await import('/js/core/data.js');
    const t = TICKETS.find(t => t.id === window.retryFixtureId);
    return {count:t.msgs.length,id:t.msgs[0]._uuid,status:t.msgs[0].email.status};
  });
  if (calls !== 1 || result.count !== 1 || result.id !== 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' || result.status !== 'sent') throw Error('Retry duplicated or failed to update the message');
  return 'Retry visible on desktop and mobile; pending button disabled; one request updates the original message.';
}
