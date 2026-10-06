// Run with scripts/serve-spa.js. All API and provider calls are local fixtures.
export default async(page) => {
  const p=await page.context().newPage();
  const customerId='11111111-1111-4111-8111-111111111111';
  const ticketId='22222222-2222-4222-8222-222222222222';
  let creates=0, sends=[], fail=false, checks=0;
  const check=(ok,message)=>{checks++;if(!ok)throw new Error(message);};
  await p.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    const data=route.request().postDataJSON();
    let body={}; let status=200;
    if(path.endsWith('/ai/messages')) { body=fail?{error:'Provider unavailable'}:{text:data.action==='detect_language'?'Spanish':'Su cuenta está lista.'};status=fail?502:200; }
    else if(path.endsWith('/tickets')&&route.request().method()==='POST') {
      creates++;status=201;body={ticket:{id:ticketId,display_id:'TK-LANG',subject:data.subject,customer_id:customerId,status_key:'open',priority_key:'normal'}};
    } else if(path.endsWith('/messages')&&route.request().method()==='POST') {
      sends.push(data);status=201;body={message:{id:'message',role:'agent',body:data.body,created_at:new Date().toISOString()},subject:'Actualización de cuenta',delivery:{emailed:true,reason:'sent'}};
    }
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  await p.goto('http://localhost:5173');
  await p.waitForFunction(()=>typeof window.login==='function');
  await p.evaluate(async()=>{
    window.login('Admin','Language Tester','LT',{userId:'language-fixture'});
    const {TICKETS}=await import('/js/core/data.js');TICKETS[0].translateThread=false;
    (await import('/js/tickets/detail.js')).openTicket(TICKETS[0].id);
  });
  for(const width of [1280,390]) {
    await p.setViewportSize({width,height:900});
    await p.locator('.ticket-language summary').click();
    await p.getByLabel('Customer language',{exact:true}).selectOption(width===1280?'Spanish':'French');
    check(await p.locator('.ticket-language').getAttribute('open')===null,'Picker closes at '+width);
    check(await p.evaluate(()=>document.activeElement.matches('.ticket-language summary')),'Focus restored at '+width);
  }
  const open=()=>p.evaluate(async customerId=>{
    const api=await import('/js/core/api-client.js');api.setJwt('language-fixture');api.setWorkspaceId('33333333-3333-4333-8333-333333333333');
    const {CUSTOMERS,CATEGORIES}=await import('/js/core/data.js');CUSTOMERS[0]._uuid=customerId;
    if(!CATEGORIES.length)CATEGORIES.push({key:'general',label:'General',is_active:true});
    (await import('/js/tickets/new-ticket.js')).showNewTicketModal(null,CUSTOMERS[0].id);
  },customerId);
  const fill=async()=>{
    await p.locator('#nt-subj').fill('Account update');
    await p.locator('#nt-cat').selectOption({index:1});
    await p.locator('[data-action="modal.confirm"]').click();
    await p.locator('#nt2-msg').fill('Su cuenta está lista.');
    await p.getByLabel('Reply language',{exact:true}).selectOption('Spanish');
  };
  await open();await fill();
  await Promise.all([p.waitForResponse(r=>r.url().endsWith('/messages')&&r.request().method()==='POST'),p.locator('[data-action="modal.confirm"]').click()]);
  await p.locator('#nt2-msg').waitFor({state:'detached'});
  check(await p.evaluate(async()=> (await import('/js/core/data.js')).TICKETS.some(t=>t.id==='TK-LANG'&&t.subject==='Actualización de cuenta')),'Translated subject updates the ticket');
  check(creates===1&&sends.length===1,'New ticket sends once');
  check(sends[0].reply_language==='Spanish'&&sends[0].body==='Su cuenta está lista.','Selected language sent even when body already matches');
  fail=true;await open();await fill();
  await p.locator('[data-action="modal.confirm"]').click();
  await p.waitForFunction(()=>!document.querySelector('[data-action="modal.confirm"]').disabled);
  check(await p.locator('#nt2-msg').inputValue()==='Su cuenta está lista.','Failed translation keeps draft');
  check(creates===1&&sends.length===1,'Failure creates and sends nothing');
  await p.close();return {checks};
};
