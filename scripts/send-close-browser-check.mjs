// Isolated local API/provider fixtures. No real customer email is sent.
export default async page => {
  let checks = 0;
  const check = (ok, message) => { checks++; if (!ok) throw Error(message); };
  for (const scenario of ['cancel','translation-failed','send-failed','not-emailed','switched-tab','sent','close-failed','optional-reason']) {
    const context = await page.context().browser().newContext();
    const p = await context.newPage();
    await p.setViewportSize({width:scenario === 'close-failed' ? 390 : 1280,height:900});
    const id = '11111111-1111-4111-8111-111111111111';
    const statuses = ['open','pending','resolved','escalated','gdpr','closed'].map(key => ({
      key,label:key,base_key:key,is_active:true,send_survey:key==='resolved',reason_required:key==='closed'&&scenario!=='optional-reason',
      reasons:key==='closed'?[{key:'other',label:'Other',is_active:true}]:[],
    }));
    const recipient = {source_message_id:null,to:['customer@example.test'],cc:[],sending_inboxes:[],default_from:'support@example.test'};
    const serverTicket = {id,display_id:'TK-001',status_key:'open',status_option_key:'open',status_survey_enabled:false,subject:'Account update',reply_recipients:recipient};
    const messages = [], requests = [], ai = [], events = [];
    const drafts = {};
    let closes = 0;
    p.on('dialog', dialog => dialog.accept());
    await p.route('**/api/**', async route => {
      const req = route.request(), path = new URL(req.url()).pathname;
      const body = req.postDataJSON(); let json = {}, status = 200;
      if (path.endsWith('/ticket-statuses')) json={statuses};
      else if (path.endsWith('/ai/messages')) {
        ai.push(body); events.push('ai');
        if(scenario==='translation-failed') {status=503;json={error:'Fixture translation unavailable'};}
        else if(body.action==='detect_language') json={text:'English'};
        else {
          let text='Su cuenta está lista.';
          try { const nodes=JSON.parse(body.messages[0].content); if(Array.isArray(nodes)) text=JSON.stringify(nodes.map(()=>'Su cuenta está lista.')); } catch {}
          json={text};
        }
      } else if(path.includes('/drafts/')) {
        const tab=path.split('/').at(-1);
        if(req.method()==='PUT') drafts[tab]={...body,version:(body.version||0)+1,attachments:[]};
        json={draft:drafts[tab]||{body:'',is_html:false,recipients:null,review:null,attachments:[],version:0}};
      } else if(path.endsWith('/messages') && req.method()==='POST') {
        requests.push(body); events.push('send');
        if(scenario==='send-failed') {status=503;json={error:'Fixture send unavailable'};}
        else {
          const message={id:'22222222-2222-4222-8222-222222222222',role:'agent',body:body.body,body_html:body.body_html,created_at:new Date().toISOString()};
          messages.push(message);
          const version=(drafts.reply?.version||0)+1;
          drafts.reply={body:'',is_html:false,recipients:null,review:null,attachments:[],version};
          json={message,draft_version:version,delivery:{emailed:scenario!=='not-emailed',reason:scenario==='not-emailed'?'send_failed':'sent'}};
        }
      } else if(path.endsWith('/close')) {
        closes++; events.push('close');
        if(scenario==='close-failed'&&closes===1) {status=503;json={error:'Fixture close unavailable'};}
        else {Object.assign(serverTicket,{status_key:'closed',status_option_key:'closed',closure_reason:body.reason,status_reason_label:body.reason?'Other':null,closed_at:new Date().toISOString()});json={ticket:serverTicket,activity:[]};}
      } else if(path.endsWith('/tickets/'+id)) json={ticket:{...serverTicket,messages,activity:[]}};
      await route.fulfill({status,json});
    });
    await p.goto('http://localhost:5173');
    await p.waitForFunction(()=>typeof window.login==='function');
    await p.evaluate(async ({id,recipient,scenario})=>{
      window.login('Admin','Send close tester','SC',{userId:'send-close-'+scenario});
      const api=await import('/js/core/api-client.js');api.setJwt('fixture');api.setWorkspaceId('33333333-3333-4333-8333-333333333333');
      const {setComposeTabValue}=await import('/js/core/state.js');setComposeTabValue('reply');
      const {TICKETS}=await import('/js/core/data.js');
      const t=TICKETS[0];Object.assign(t,{_uuid:id,_detailLoaded:true,status:'open',statusOption:'open',subject:'Account update',msgs:[],translateThread:false,replyRecipients:recipient});
      const {openTicket}=await import('/js/tickets/detail.js');openTicket(t.id);
      (await import('/js/ai/translate.js')).setCustomerLanguage(t.id,'Spanish');
      const composer=await import('/js/tickets/composer.js');await composer.mountComposer(t.id);
    },{id,recipient,scenario});
    await p.waitForFunction(()=>!document.querySelector('[data-action="td.send"]')?.disabled);
    await p.evaluate(async()=>{
      const composer=await import('/js/tickets/composer.js');composer.setHtml('TK-001','<p><strong>Your account is ready.</strong></p>');
      (await import('/js/tickets/detail.js')).onComposeInput('TK-001');
    });
    await p.getByRole('button',{name:'More send options',exact:true}).click();
    await p.getByRole('button',{name:'Send and close — no survey',exact:true}).click();
    await p.locator('#closure-reason').waitFor();
    check(requests.length===0&&closes===0,'Opening does not send or close');
    if(scenario==='cancel') {
      await p.keyboard.press('Escape');
      check(requests.length===0&&closes===0,'Cancellation does not send or close');
      check(await p.evaluate(async()=> (await import('/js/tickets/composer.js')).getPlainText('TK-001').includes('Your account')),'Cancellation preserves draft');
      await context.close();continue;
    }
    if(scenario!=='optional-reason') {
      await p.locator('[data-action="modal.confirm"]').click();
      check((await p.locator('#closure-error').innerText()).includes('Choose a closure reason'),'Reason validated before send');
      check(requests.length===0&&closes===0,'Missing reason blocks all writes');
      await p.locator('#closure-reason').selectOption('other');
    }
    await p.screenshot({path:`send-close-${scenario}.png`});
    const aiBefore = ai.length;
    if(scenario==='switched-tab') await p.evaluate(async()=> (await import('/js/core/state.js')).setComposeTabValue('note'));
    await p.locator('[data-action="modal.confirm"]').click();
    if(['translation-failed','send-failed','not-emailed','switched-tab'].includes(scenario)) {
      await p.locator('#closure-error').filter({hasText:'not confirmed sent'}).waitFor();
      check(closes===0&&serverTicket.status_key==='open','Failure leaves ticket open');
      if(scenario==='translation-failed') check(requests.length===0,'Translation failure sends nothing');
      if(scenario==='switched-tab') check(requests.length===0&&ai.length===aiBefore,'Changing to an internal note cannot send or close');
      if(scenario==='not-emailed') check(requests.length===1,'Saved but not emailed does not close');
      if(scenario!=='not-emailed') check(await p.evaluate(async()=> (await import('/js/tickets/composer.js')).getPlainText('TK-001').includes('Your account')),'Unsent draft is kept');
    } else {
      if(scenario==='close-failed') {
        await p.locator('.closure-modal').getByRole('button',{name:'Retry close only',exact:true}).waitFor();
        check(await p.locator('.ticket-close-reminder').count()===1,'Failed closure leaves a persistent reminder on the ticket');
        const calls=ai.length;
        check(requests.length===1&&closes===1,'First attempt sends once and attempts closure');
        check(await p.locator('#closure-reason').isDisabled(),'Sent reply freezes closure details');
        await p.locator('.closure-modal').getByRole('button',{name:'Retry close only',exact:true}).click();
        await p.locator('.closure-modal').waitFor({state:'detached'});
        check(ai.length===calls&&requests.length===1&&closes===2,'Retry closes only without another AI request or email');
      } else await p.locator('.closure-modal').waitFor({state:'detached'});
      check(serverTicket.status_key==='closed'&&serverTicket.status_survey_enabled===false,'Closed with surveys disabled');
      check(await p.locator('.ticket-close-reminder').count()===0,'Confirmed closure clears the reminder');
      check(requests.length===1&&ai.length>0,'Normal AI flow sends once');
      check(requests[0].reply_language==='Spanish'&&requests[0].body.includes('Su cuenta'),'Translated body and branding language reach sender');
      check(requests[0].body_html.includes('<strong>'),'Rich formatting survives translation');
      check(events.indexOf('send')<events.indexOf('close'),'Send finishes before closure');
    }
    await context.close();
  }
  return {checks};
};
