// Local API/provider fixtures only. No real customer email or survey is sent.
export default async page => {
  let checks=0;
  const check=(ok,message)=>{checks++;if(!ok)throw Error(message);};
  for(const scenario of ['sent','optional','cancel','empty','create-failed','incomplete','translation-failed','send-failed','unconfirmed','close-failed','inactive','switched','demo']) {
    const context=await page.context().browser().newContext(),p=await context.newPage();
    try {
      await p.setViewportSize({width:scenario==='close-failed'?390:1280,height:900});
      const id='11111111-1111-4111-8111-111111111111',customerId='22222222-2222-4222-8222-222222222222';
      const statuses=['open','pending','resolved','escalated','gdpr','closed'].map(key=>({key,label:key,base_key:key,
        is_active:true,send_survey:key==='resolved',reason_required:key==='closed'&&scenario!=='optional',
        reasons:key==='closed'&&scenario!=='optional'?[{key:'other',label:'Other',is_active:true}]:[]}));
      const row={id,display_id:'TK-NEW',customer_id:customerId,subject:'Account update',status_key:'open',status_option_key:'open',status_survey_enabled:false,priority_key:'normal'};
      const messages=[],bodies=[],drafts={};let creates=0,closes=0,ai=0,statusLoads=0;
      p.on('dialog',dialog=>dialog.accept());
      const reminders=new Map(); let generation=0;
      await p.route('**/api/**',async route=>{
        const req=route.request(),path=new URL(req.url()).pathname,body=req.postDataJSON();let json={},status=200;
        if(path.endsWith('/close-reminder')) {
          const key=req.headers()['authorization']+':'+req.headers()['x-workspace-id'];
          let reminder=reminders.get(key)||{pending:false,version:0};
          if(req.method()==='PUT') {
            if(body.version!==reminder.version||body.generation!==generation)status=409;
            else {reminder={pending:body.pending&&row.status_key!=='closed',version:reminder.version+1};reminders.set(key,reminder);}
          }
          json={reminder:{...reminder,generation}};
        } else if(path.endsWith('/ticket-statuses')){statusLoads++;json={statuses:statuses.map(s=>({...s,is_active:!(s.key==='closed'&&scenario==='inactive'&&statusLoads>1)}))};}
        else if(path.endsWith('/customers/'+customerId)&&req.method()==='PATCH')json={customer:{preferred_language:body.preferred_language}};
        else if(path.endsWith('/ai/messages')) {
          ai++;
          if(scenario==='translation-failed'){status=503;json={error:'Fixture AI unavailable'};}
          else json={text:body.action==='detect_language'?'English':'Su cuenta está lista.'};
        } else if(path.endsWith('/tickets')&&req.method()==='POST') {
          creates++;
          if(scenario==='create-failed'){status=503;json={error:'Fixture create unavailable'};}
          else {
            Object.assign(row,body);json={ticket:scenario==='incomplete'?{}:row};
            if(scenario==='switched')await p.evaluate(async()=>{(await import('/js/core/api-client.js')).setWorkspaceId('44444444-4444-4444-8444-444444444444');});
          }
        } else if(path.endsWith('/messages')&&req.method()==='POST') {
          bodies.push(body);
          if(scenario==='send-failed'){status=503;json={error:'Fixture send unavailable'};}
          else {const message={id:'message',role:'agent',body:body.body,created_at:new Date().toISOString()};messages.push(message);json={message,delivery:{emailed:scenario!=='unconfirmed',reason:scenario==='unconfirmed'?'delivery_unconfirmed':'sent'}};}
        } else if(path.endsWith('/close')) {
          closes++;
          if(scenario==='close-failed'&&closes===1){status=503;json={error:'Fixture close unavailable'};}
          else {generation++;for(const reminder of reminders.values()){reminder.pending=false;reminder.version++;}Object.assign(row,{status_key:'closed',status_option_key:'closed',closure_reason:body.reason,status_reason_label:body.reason?'Other':null,closed_at:new Date().toISOString()});json={ticket:row,activity:[]};}
        } else if(path.includes('/drafts/')) {
          const tab=path.split('/').at(-1);
          if(req.method()==='PUT')drafts[tab]={...body,version:(body.version||0)+1,attachments:[]};
          json={draft:drafts[tab]||{body:'',is_html:false,recipients:null,review:null,attachments:[],version:0}};
        } else if(path.endsWith('/tickets/'+id))json={ticket:{...row,messages,activity:[],reply_recipients:{to:['fixture@example.test'],cc:[],sending_inboxes:[],source_message_id:null}}};
        await route.fulfill({status,json});
      });
      await p.goto('http://localhost:5173');
      await p.waitForFunction(()=>typeof window.login==='function');
      await p.evaluate(async({customerId,scenario})=>{
        window.login('Admin','First message tester','FM',{userId:'first-message-'+scenario});
        const {CUSTOMERS,CATEGORIES}=await import('/js/core/data.js');
        CUSTOMERS[0].preferredLanguage='Spanish';CUSTOMERS[0].jurisdiction='CL';
        if(scenario!=='demo') {
          const api=await import('/js/core/api-client.js');api.setJwt('fixture');api.setWorkspaceId('33333333-3333-4333-8333-333333333333');
          CUSTOMERS[0]._uuid=customerId;
          if(!CATEGORIES.length)CATEGORIES.push({key:'general',label:'General',is_active:true});
        }
        await (await import('/js/tickets/new-ticket.js')).showNewTicketModal(null,CUSTOMERS[0].id);
      },{customerId,scenario});
      await p.locator('#nt-subj').fill('Account update');await p.locator('#nt-cat').selectOption({index:1});
      await p.locator('[data-action="modal.confirm"]').click();
      await p.getByRole('button',{name:'Confirm and continue',exact:true}).click();
      await p.locator('#nt2-msg').fill(scenario==='empty'?'':'Your account is ready.');
      await p.locator('#nt2-after-send').selectOption('closed');
      check(await p.locator('#nt2-msg').inputValue()===(scenario==='empty'?'':'Your account is ready.'),'Changing the option preserves the first message');
      check(await p.getByRole('button',{name:'Send & close',exact:true}).count()===1,'Footer names the selected action');
      check(creates===0&&bodies.length===0&&closes===0,'Selecting the option creates and sends nothing');
      if(scenario==='cancel') {
        await p.locator('#nt2-close-reason').selectOption('other');
        await p.locator('[data-action="nt.back"]').click();await p.locator('[data-action="modal.confirm"]').click();
        check(await p.locator('#nt2-msg').inputValue()==='Your account is ready.','Returning from details preserves the draft');
        check(await p.locator('#nt2-close-reason').inputValue()==='other','Returning preserves the closure reason');
        await p.locator('#nt2-after-send').selectOption('');
        check(await p.getByRole('button',{name:'Send',exact:true}).count()===1,'Can return to normal Send');
        check(await p.locator('#nt2-without-ai-btn').isEnabled(),'Normal manual send remains available');
        await p.getByRole('button',{name:'Cancel',exact:true}).click();
        check(creates===0&&bodies.length===0&&closes===0,'Cancellation does not create, send or close');
        continue;
      }
      if(scenario!=='optional'&&scenario!=='empty') {
        await p.locator('[data-action="modal.confirm"]').click();
        await p.waitForFunction(()=>!document.querySelector('[data-action="modal.confirm"]').disabled);
        check(creates===0&&bodies.length===0,'Missing reason or inactive status blocks creation and sending');
        await p.locator('#nt2-close-reason').selectOption('other');
      }
      await p.screenshot({path:`new-ticket-close-${scenario}.png`});
      await p.locator('[data-action="modal.confirm"]').evaluate(button=>{button.click();button.click();});
      if(['create-failed','translation-failed','inactive','empty'].includes(scenario)) {
        await p.waitForFunction(()=>!document.querySelector('[data-action="modal.confirm"]').disabled);
        check(bodies.length===0&&closes===0,'Failed pre-send step cannot send or close');
        check(await p.locator('#nt2-msg').inputValue()===(scenario==='empty'?'':'Your account is ready.'),'Failure preserves the composer');
        check(creates===(scenario==='create-failed'?1:0),'Pre-send failures never retry ticket creation automatically');
      } else {
        await p.locator('#nt2-msg').waitFor({state:'detached'});
        if(scenario==='incomplete') {
          check(await p.locator('#nt-recovery-message').inputValue()==='Su cuenta está lista.','Incomplete creation response keeps the unsent message available to copy');
          check(creates===1&&bodies.length===0&&closes===0,'Incomplete creation response prevents duplicate creation, sending and closure');
          continue;
        }
        if(scenario==='switched') {
          check(creates===1&&bodies.length===0&&closes===0,'Workspace change after creation cannot send or close in another workspace');
          continue;
        }
        if(scenario==='demo') {
          await p.waitForFunction(()=>document.querySelector('[aria-label="Ticket status"]')?.value==='closed');
          check(creates===0&&closes===0,'Demo creation and closure stay local');
          continue;
        }
        if(scenario==='close-failed') {
          await p.locator('.closure-modal').getByRole('button',{name:'Retry close only',exact:true}).waitFor();
          check(await p.locator('.ticket-close-reminder').count()===1,'Failed first-message closure leaves a reminder on the ticket');
          check((await p.locator('#closure-error').innerText()).includes('first email was sent'),'Closure failure explains the email already went out');
          const aiBefore=ai;
          await p.locator('.closure-modal').getByRole('button',{name:'Retry close only',exact:true}).click();
          await p.locator('.closure-modal').waitFor({state:'detached'});
          check(creates===1&&bodies.length===1&&closes===2&&ai===aiBefore,'Close retry does not recreate, regenerate or resend');
        }
        if(['send-failed','unconfirmed'].includes(scenario)) {
          check(creates===1&&bodies.length===1&&closes===0,'Sending failure opens the existing ticket without closing');
          if(scenario==='send-failed')check(await p.evaluate(async()=>!!(await import('/js/tickets/drafts.js')).loadDraft('TK-NEW','reply')),'Failed first message is kept on the created ticket');
        } else {
          await p.waitForFunction(()=>document.querySelector('[aria-label="Ticket status"]')?.value==='closed');
          check(creates===1&&bodies.length===1,'Successful first-message flow creates and sends once');
          check(row.status_survey_enabled===false&&row.status_key==='closed',`${scenario}: closed status has no survey (${row.status_key}/${row.status_survey_enabled}, ${closes} closes)`);
          check(await p.locator('.ticket-close-reminder').count()===0,'Confirmed first-message closure clears the reminder');
          check(bodies[0].reply_language==='Spanish'&&bodies[0].body.includes('Su cuenta'),'Normal translation and branding language are used');
        }
      }
    } finally {await context.close();}
  }
  return {checks};
};
