// Local fixtures only: exercise actual reloads without sending customer email.
export default async page => {
  let checks = 0;
  const check = (ok, message) => { checks++; if (!ok) throw Error(message); };
  for (const [scenario, width] of [['retry',390],['retry',768],['retry',1280],['retry',1920],['refresh-failed',1280],['dismiss',390],['already-closed',1280],['status-failed',1280],['inactive',1280],['switched',1280]]) {
    const context = await page.context().browser().newContext(), p = await context.newPage();
    try {
      await p.setViewportSize({ width, height:900 });
      const uuid = '11111111-1111-4111-8111-111111111111', workspace = '33333333-3333-4333-8333-333333333333';
      const row = {id:uuid,display_id:'TK-001',subject:'Account update',status_key:'open',status_option_key:'open',priority_key:'normal',status_survey_enabled:false};
      let closes=0, sends=0, ai=0, failStatus=false;
      p.on('dialog', d => d.accept());
      const reminders=new Map(); let generation=0;
      await p.route('**/api/**', async route => {
        const req=route.request(), path=new URL(req.url()).pathname, body=req.postDataJSON(); let json={}, status=200;
        if(path.endsWith('/close-reminder')) {
          const key=req.headers()['authorization']+':'+req.headers()['x-workspace-id'];
          let reminder=reminders.get(key)||{pending:false,version:0};
          if(req.method()==='PUT') {
            if(body.version!==reminder.version||body.generation!==generation)status=409;
            else {reminder={pending:body.pending&&row.status_key!=='closed',version:reminder.version+1};reminders.set(key,reminder);}
          }
          json={reminder:{...reminder,generation}};
        } else if(path.endsWith('/ticket-statuses'))json={statuses:['open','closed'].map(key=>({key,label:key,base_key:key,is_active:!(scenario==='inactive'&&key==='closed'),send_survey:false,reason_required:key==='closed',reasons:key==='closed'?[{key:'other',label:'Other',is_active:true}]:[]}))};
        else if(path.endsWith('/tickets/'+uuid)) {
          if(failStatus){status=503;json={error:'Fixture status unavailable'};}
          else json={ticket:{...row,messages:[],activity:[]}};
          if(scenario==='switched'&&failStatus)await p.evaluate(async()=>{(await import('/js/core/api-client.js')).setWorkspaceId('another-workspace');});
        } else if(path.endsWith('/close')) {
          closes++;
          if(closes===1){status=503;json={error:'Fixture close unavailable'};}
          else {generation++;for(const reminder of reminders.values()){reminder.pending=false;reminder.version++;}Object.assign(row,{status_key:'closed',status_option_key:'closed',closure_reason:'other'});json={ticket:row,activity:[]};if(scenario==='refresh-failed')failStatus=true;}
        } else if(path.endsWith('/messages')&&req.method()==='POST')sends++;
        else if(path.endsWith('/ai/messages'))ai++;
        else if(path.includes('/drafts/'))json={draft:{body:'',is_html:false,attachments:[],version:0}};
        await route.fulfill({status,json});
      });
      const open = async () => {
        await p.waitForFunction(()=>typeof window.login==='function');
        await p.evaluate(async({uuid,workspace})=>{
          window.login('Admin','Reminder tester','RT',{userId:'reminder-agent'});
          const api=await import('/js/core/api-client.js');api.setJwt('fixture');api.setWorkspaceId(workspace);
          const {TICKETS}=await import('/js/core/data.js');
          Object.assign(TICKETS[0],{_uuid:uuid,status:'open',statusOption:'open',_detailLoaded:true,msgs:[],translateThread:false});
          (await import('/js/ai/translate.js')).setCustomerLanguage('TK-001','English');
          await (await import('/js/core/bootstrap.js')).loadTicketDetail('TK-001',{force:true});
          (await import('/js/tickets/detail.js')).openTicket('TK-001');
        },{uuid,workspace});
      };
      await p.goto('http://localhost:5173'); await open();
      await p.evaluate(async()=>{const {TICKETS}=await import('/js/core/data.js');await (await import('/js/tickets/close-reminder.js')).markCloseReminder(TICKETS[0]);});
      await p.reload(); await open();
      const notice=p.locator('.ticket-close-reminder');
      check(await notice.count()===1,'Reminder survives a real page reload');
      check(sends===0&&ai===0&&closes===0,'Restoring a reminder triggers no send, AI or closure');
      await p.evaluate(async()=>{const {SESSION}=await import('/js/core/state.js');SESSION.userId='another-agent';(await import('/js/core/api-client.js')).setJwt('other-agent');(await import('/js/ai/translate.js')).setCustomerLanguage('TK-001','English');(await import('/js/tickets/detail.js')).openTicket('TK-001');});
      check(await notice.count()===0,'Another agent cannot see the reminder');
      await p.evaluate(async()=>{const api=await import('/js/core/api-client.js');const {SESSION}=await import('/js/core/state.js');SESSION.userId='reminder-agent';api.setJwt('fixture');api.setWorkspaceId('other');(await import('/js/ai/translate.js')).setCustomerLanguage('TK-001','English');(await import('/js/tickets/detail.js')).openTicket('TK-001');});
      check(await notice.count()===0,'Another workspace cannot see the reminder');
      await p.evaluate(async workspace=>{(await import('/js/core/api-client.js')).setWorkspaceId(workspace);(await import('/js/ai/translate.js')).setCustomerLanguage('TK-001','English');(await import('/js/tickets/detail.js')).openTicket('TK-001');},workspace);
      await p.screenshot({path:`close-reminder-${scenario}-${width}.png`});
      if(scenario==='retry'&&width<=768)check(await notice.locator('button').evaluateAll(buttons=>buttons.every(b=>b.getBoundingClientRect().height>=44)),'Reminder buttons have 44px touch targets');
      if(scenario==='retry') {
        await notice.getByRole('button',{name:'Retry close only',exact:true}).focus();
        check(await p.evaluate(()=>getComputedStyle(document.activeElement).outlineStyle!=='none'),'Keyboard focus is visible');
        await p.keyboard.press('Tab');
        check(await p.evaluate(()=>document.activeElement.dataset.action==='td.dismissCloseReminder'),'Keyboard order reaches dismissal');
      }
      if(scenario==='dismiss') {
        await notice.getByRole('button',{name:'Dismiss reminder',exact:true}).click();
        await p.reload();await open();
        check(await notice.count()===0&&row.status_key==='open'&&closes===0,'Dismissal survives reload without changing status');
      } else {
        if(scenario==='already-closed')Object.assign(row,{status_key:'closed',status_option_key:'closed'});
        if(['status-failed','switched'].includes(scenario))failStatus=true;
        await notice.getByRole('button',{name:'Retry close only',exact:true}).click();
        if(scenario==='already-closed') {
          await notice.waitFor({state:'detached'});
          check(closes===0,'Fresh server status prevents closing an already closed ticket');
        } else if(['status-failed','inactive','switched'].includes(scenario)) {
          await p.waitForFunction(()=>document.querySelector('[data-action="td.retryCloseOnly"]')?.disabled===false);
          check(await p.locator('.closure-modal').count()===0&&closes===0,'Status failure, inactive status or workspace switch blocks closure');
          if(scenario!=='switched')check(await notice.getByRole('button',{name:'Retry close only'}).isEnabled(),'Failed preflight restores the retry button');
        } else {
          await p.locator('.closure-modal').waitFor();
          await p.locator('[data-action="modal.confirm"]').click();
          check(closes===0,'Closure reason is required before a retry');
          await p.locator('#closure-reason').selectOption('other');
          await p.locator('[data-action="modal.confirm"]').click();
          await p.locator('#closure-error').filter({hasText:'Fixture close unavailable'}).waitFor();
          check(await notice.count()===1&&closes===1,'A failed retry keeps the reminder');
          await p.keyboard.press('Escape');
          await notice.getByRole('button',{name:'Retry close only',exact:true}).click();
          await p.locator('#closure-reason').selectOption('other');
          await p.locator('[data-action="modal.confirm"]').click();
          await notice.waitFor({state:'detached'});
          check(closes===2&&row.status_key==='closed','Confirmed closure clears the reminder');
          if(scenario==='refresh-failed') {
            await p.getByText('Ticket closed, but its details could not be refreshed. Reload to check the latest details.',{exact:true}).waitFor();
            check(await notice.count()===0,'Detail refresh failure does not undo a confirmed closure');
            failStatus=false;
          }
          await p.reload();await open();
          check(await notice.count()===0,'Successful recovery stays cleared after reload');
        }
      }
      check(sends===0&&ai===0,'Reminder recovery never resends or regenerates a reply');
      if(scenario==='retry')check(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Reminder fits the viewport');
    } catch (error) {
      await p.screenshot({path:`close-reminder-error-${scenario}-${width}.png`});
      throw new Error(`${scenario}/${width}: ${error.message}`);
    } finally { await context.close(); }
  }
  return { checks };
};
