export default async function checkEmailForwards(page) {
  const check = (ok, message) => { if (!ok) throw Error(message); };
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.goto('http://localhost:5173');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.evaluate(() => window.login('Admin', 'Download tester', 'DT'));
  await page.evaluate(async () => {
    const { TICKETS } = await import('/js/core/data.js');
    const ticket = TICKETS[0];
    ticket._uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    ticket._detailLoaded = true;
    ticket.msgs = [
      { _uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', r: 'customer', from: 'Customer', t: 'Saved email', downloadableEmail: true },
      { _uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', r: 'note', from: 'Agent', t: 'Internal note' },
    ];
    sessionStorage.setItem('maestro_jwt', 'fixture-session');
    sessionStorage.setItem('maestro_workspace_id', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    await (await import('/js/tickets/detail.js')).openTicket(ticket.id);
  });

  let requests=[], fail=true;
  await page.route('**/emails/*/forward', async route=>{
    if(route.request().method()==='GET') return route.fulfill({json:{source_version:'a'.repeat(64),subject:'Fwd: Original subject',default_from:'support@example.test',sending_inboxes:[],default_sending_channel_id:null,
      original:{html:'<h2>Original email</h2><p>Original formatting</p>'},attachments:[{id:'ffffffff-ffff-4fff-8fff-ffffffffffff',filename:'receipt.txt',is_inline:false,url:null}]}});
    requests.push(route.request().postDataJSON());
    await route.fulfill(fail?{status:503,json:{error:'File unavailable. Try again.',retryable:true}}:{status:201,json:{sent:true}});
  });
  const forward=page.getByRole('button',{name:'Forward',exact:true});
  check(await forward.count()===1,'Internal notes cannot be forwarded');
  await page.locator('[data-compose-launch][data-tab="reply"]').click();
  await page.locator('.ql-editor').fill('UNSENT CUSTOMER REPLY');
  await forward.click();
  await page.locator('#forward-to').waitFor();
  check(await page.getByRole('dialog',{name:'Forward email'}).count()===1,'Forward dialog is named');
  await page.getByRole('button',{name:'Send forward',exact:true}).focus();
  await page.keyboard.press('Tab');
  check(await page.getByRole('button',{name:'Close forwarding form'}).evaluate(el=>el===document.activeElement),'Keyboard focus stays inside the dialog');
  check(await page.locator('#forward-to').inputValue()==='','Recipients start empty');
  check(await page.locator('#forward-subject').inputValue()==='Fwd: Original subject','Forward subject');
  await page.locator('#forward-to').fill('supplier@example.test');
  await page.locator('#forward-cc').fill('colleague@example.test');
  await page.locator('#forward-message').fill('Please investigate.');
  await page.locator('[name="forward-file"]').uncheck();
  await page.getByText('Original email',{exact:true}).first().click();
  check(await page.locator('iframe[title="Original email"]').getAttribute('sandbox')==='allow-same-origin','Preview disallows scripts');
  if(process.env.FORWARD_SCREENSHOT_DIR) await page.screenshot({path:process.env.FORWARD_SCREENSHOT_DIR+'/respovia-forward-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile form fits');
  if(process.env.FORWARD_SCREENSHOT_DIR) await page.screenshot({path:process.env.FORWARD_SCREENSHOT_DIR+'/respovia-forward-mobile.png'});
  await page.getByRole('button',{name:'Send forward',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('forward-error')?.textContent.includes('File unavailable'));
  check(await page.locator('#forward-message').inputValue()==='Please investigate.','Failure preserves forward draft');
  check((await page.locator('.ql-editor').innerText()).includes('UNSENT CUSTOMER REPLY'),'Customer reply draft remains intact');
  fail=false;
  await page.getByRole('button',{name:'Send forward',exact:true}).click();
  await page.locator('#email-forward-form').waitFor({state:'detached'});
  check(requests.length===2,'User retry sends one request');
  check(requests[0].request_id!==requests[1].request_id,'Confirmed pre-send failure gets a new attempt ID');
  check(requests[1].attachment_ids.length===0,'Deselected attachment excluded');
  check(requests[1].to[0]==='supplier@example.test' && requests[1].cc[0]==='colleague@example.test','Chosen recipients forwarded');
  return {checks:'forward action, empty recipients, original preview, attachment selection, failure draft preservation, retry, desktop and mobile'};
}
