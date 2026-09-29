// Local fixture only. Run with the Playwright tool against scripts/serve-spa.js.
export default async function checkEmailDetails(page) {
  if (!page.url().startsWith('http://localhost:5173/')) throw Error('Local fixture only');
  await page.route('**/api/**', route => route.fulfill({json:{}}));
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.setViewportSize({width:1280,height:900});
  await page.evaluate(async () => {
    window.login('Admin','Email tester','ET');
    (await import('/js/guides/index.js')).closeGuides(false);
    const {TICKETS}=await import('/js/core/data.js');
    const t=TICKETS[0];
    (await import('/js/tickets/drafts.js')).clearAllDrafts(t.id);
    Object.assign(t,{_uuid:'00000000-0000-4000-8000-000000000001',_detailLoaded:true,autoTranslateReplies:false,
      replyRecipients:{source_message_id:'00000000-0000-4000-8000-000000000002',to:['customer@example.test'],cc:['colleague@example.test'],
        default_sending_channel_id:'vip',default_from:'support@spacecasino.com',
        sending_inboxes:[{id:'vip',address:'vip@spacecasino.com'},{id:'support',address:'support@spacecasino.com'}]},
      msgs:[{from:'Customer',r:'customer',t:'Please help with my account.',createdAt:'2026-09-29T12:30:05Z',
        email:{from:'customer@example.test',to:['vip@spacecasino.com'],cc:['colleague@example.test'],status:'received',received_via:'vip@spacecasino.com',sent_at:'2026-09-29T12:30:00Z'}}]});
    window.emailFixtureId=t.id;
    (await import('/js/tickets/detail.js')).openTicket(t.id);
  });
  await page.locator('[data-compose-launch][data-tab="reply"]').click();
  await page.locator('.ql-editor').fill('My reply draft');
  const mode=page.locator('[data-change-action="td.replyMode"]'), cc=page.locator('[data-input-action="td.replyCc"]');
  const from=page.locator('[data-change-action="td.replyFrom"]');
  if(await from.inputValue()!=='vip')throw Error('Receiving inbox was not the default sender');
  await from.selectOption('support');
  await mode.selectOption('reply_all');
  if (await cc.inputValue()!=='colleague@example.test') throw Error('Reply all missing CC');
  await cc.fill('reviewer@example.test, second@example.test');
  await page.evaluate(async()=>{(await import('/js/tickets/detail.js')).openTicket(window.emailFixtureId);});
  if ((await cc.inputValue()).replaceAll(' ','')!=='reviewer@example.test,second@example.test') throw Error('CC draft was not restored');
  if (await mode.inputValue()!=='reply_all') throw Error('Reply mode was not restored');
  if (await from.inputValue()!=='support') throw Error('Sending inbox was not restored');
  if (!(await page.locator('.ql-editor').innerText()).includes('My reply draft')) throw Error('Changing recipients lost the body');
  await page.locator('.composer-tabs [data-tab="note"]').click();
  if (await cc.count()) throw Error('Internal note exposes email controls');
  if (await from.count()) throw Error('Internal note exposes sender controls');
  await page.locator('.composer-tabs [data-tab="reply"]').click();
  if ((await cc.inputValue()).replaceAll(' ','')!=='reviewer@example.test,second@example.test') throw Error('Tab switch lost CC draft');
  await mode.selectOption('reply');
  if (await cc.inputValue()!=='') throw Error('Reply unexpectedly includes reply-all recipients');
  await cc.fill('invalid-address');
  if (await cc.evaluate(el=>el.checkValidity())) throw Error('Invalid CC accepted');
  await cc.fill('reviewer@example.test');
  const details=await page.locator('.message-email-details').innerText();
  if (!details.includes('vip@spacecasino.com') || !details.includes('colleague@example.test')) throw Error('Email envelope missing');
  if (!(await page.locator('.message-time').innerText()).includes('29 Sept 2026')) throw Error('Full date missing');
  await page.setViewportSize({width:700,height:900});
  if (await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth)) throw Error('Page overflows');
  await page.setViewportSize({width:1280,height:900});
  await page.evaluate(async()=>{
    const {TICKETS}=await import('/js/core/data.js');
    const ticket=TICKETS.find(t=>t.id===window.emailFixtureId);
    ticket.replyRecipients.sending_inboxes=ticket.replyRecipients.sending_inboxes.filter(inbox=>inbox.id!=='support');
    (await import('/js/tickets/detail.js')).openTicket(ticket.id);
  });
  if(!(await from.locator('option:checked').innerText()).includes('unavailable'))throw Error('Unavailable saved sender silently changed');
  await from.selectOption('vip');
  await page.evaluate(async()=>{
    const {TICKETS}=await import('/js/core/data.js');
    const ticket=TICKETS.find(t=>t.id===window.emailFixtureId);
    const payload=(await import('/js/tickets/email-details.js')).replyRecipientPayload(ticket);
    if(payload.sending_channel_id!=='vip'||payload.sending_address!=='vip@spacecasino.com')throw Error('Sender missing from send payload');
  });
  return {checks:'Full date, inbox, From/To/CC, reply modes, recipient drafts, sender selection/restoration/expiry, note isolation, CC validation, responsive overflow'};
}
