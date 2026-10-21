// Two isolated browser profiles share fixture server state. No live email or AI calls.
export default async page => {
  let checks=0,sends=0,ai=0,closes=0,generation=0;
  const check=(ok,message)=>{checks++;if(!ok)throw Error(message);};
  const contexts=[],reminders=new Map(),offline=new Set();
  const uuid='11111111-1111-4111-8111-111111111111',workspace='33333333-3333-4333-8333-333333333333';
  const row={id:uuid,display_id:'TK-001',subject:'Account update',status_key:'open',status_option_key:'open',priority_key:'normal',status_survey_enabled:false};
  const create=async(width)=>{
    const context=await page.context().browser().newContext();contexts.push(context);
    const p=await context.newPage();await p.setViewportSize({width,height:900});
    await p.route('**/api/**',async route=>{
      const req=route.request(),path=new URL(req.url()).pathname,body=req.postDataJSON();let status=200,json={};
      if(path.endsWith('/close-reminder')) {
        if(offline.has(p))return route.abort('internetdisconnected');
        const key=req.headers()['authorization']+':'+req.headers()['x-workspace-id'];
        let reminder=reminders.get(key)||{pending:false,version:0};
        if(req.method()==='PUT') {
          if(body.version!==reminder.version||body.generation!==generation)status=409;
          else {reminder={pending:body.pending&&row.status_key!=='closed',version:reminder.version+1};reminders.set(key,reminder);}
        }
        json={reminder:{...reminder,generation}};
      } else if(path.endsWith('/ticket-statuses'))json={statuses:['open','closed'].map(key=>({key,label:key,base_key:key,is_active:true,send_survey:false,reason_required:false,reasons:[]}))};
      else if(path.endsWith('/tickets/'+uuid))json={ticket:{...row,messages:[],activity:[]}};
      else if(path.endsWith('/close')) {
        closes++;generation++;for(const r of reminders.values()){r.pending=false;r.version++;}
        Object.assign(row,{status_key:'closed',status_option_key:'closed'});json={ticket:row,activity:[]};
      } else if(path.endsWith('/messages')&&req.method()==='POST')sends++;
      else if(path.endsWith('/ai/messages'))ai++;
      else if(path.includes('/drafts/'))json={draft:{body:'',is_html:false,attachments:[],version:0}};
      await route.fulfill({status,json});
    });
    await p.goto('http://localhost:5173');return p;
  };
  const open=async(p,user='same-agent',ws=workspace)=>{
    await p.waitForFunction(()=>typeof window.login==='function');
    await p.evaluate(async({uuid,user,ws})=>{
      window.login('Admin','Reminder fixture','RF',{userId:user});
      const api=await import('/js/core/api-client.js');api.setJwt(user);api.setWorkspaceId(ws);
      const {TICKETS}=await import('/js/core/data.js');
      Object.assign(TICKETS[0],{_uuid:uuid,status:'open',statusOption:'open',_detailLoaded:true,msgs:[],translateThread:false});
      (await import('/js/ai/translate.js')).setCustomerLanguage('TK-001','English');
      await (await import('/js/core/bootstrap.js')).loadTicketDetail('TK-001',{force:true});
      (await import('/js/tickets/detail.js')).openTicket('TK-001');
      await (await import('/js/tickets/close-reminder.js')).loadCloseReminder(TICKETS[0],{force:true});
    },{uuid,user,ws});
  };
  const action=async(p,name)=>p.evaluate(async name=>{
    const {TICKETS}=await import('/js/core/data.js');await (await import('/js/tickets/close-reminder.js'))[name](TICKETS[0],{force:true});
  },name);
  const count=p=>p.locator('.ticket-close-reminder').count();
  try {
    const a=await create(390),b=await create(1280);await open(a);
    const key=`close-reminder:v1:${workspace}:same-agent:${uuid}`;
    // Simulate an existing pre-sync browser reminder and reopen in the upgraded app.
    await a.evaluate(key=>localStorage.setItem(key,'1'),key);await a.reload();await open(a);
    check(await count(a)===1,'Legacy browser reminder imports to the server');
    await open(b);check(await count(b)===1,'A separate browser profile loads the same agent reminder');
    await b.screenshot({path:'cross-device-reminder-desktop.png'});await a.screenshot({path:'cross-device-reminder-mobile.png'});
    await b.getByRole('button',{name:'Dismiss reminder',exact:true}).click();await action(b,'loadCloseReminder');
    await action(a,'loadCloseReminder');check(await count(a)===0&&await count(b)===0,'Dismissal synchronizes to the other profile');
    await a.evaluate(key=>localStorage.setItem(key,JSON.stringify({pending:true,version:1,generation:0,dirty:true})),key);
    await a.reload();await open(a);check(await count(a)===0,'An old offline edit cannot resurrect a dismissed reminder');
    await a.evaluate(key=>localStorage.setItem(key,'1'),key);await a.reload();await open(a);
    check(await count(a)===0,'A stale legacy browser cannot re-import a cleared reminder');
    await action(a,'markCloseReminder');await action(b,'loadCloseReminder');check(await count(b)===1,'A new confirmed-send reminder can be shared after dismissal');
    await open(b,'other-agent');check(await count(b)===0,'Another authenticated agent has no access to the reminder');
    await open(b,'same-agent','another-workspace');check(await count(b)===0,'Another workspace has no reminder');
    await open(b);
    offline.add(a);await action(a,'markCloseReminder');check(await count(a)===1,'Connection failure preserves the local reminder');
    await b.getByRole('button',{name:'Dismiss reminder',exact:true}).click();await action(b,'loadCloseReminder');
    offline.delete(a);await action(a,'loadCloseReminder');check(await count(a)===0,'Reconnect uses the server-cleared version instead of an old offline save');
    await action(a,'markCloseReminder');await action(b,'loadCloseReminder');
    await b.getByRole('button',{name:'Retry close only',exact:true}).click();
    await b.locator('.closure-modal').waitFor();await b.locator('[data-action="modal.confirm"]').click();
    await b.locator('.closure-modal').waitFor({state:'detached'});await action(a,'loadCloseReminder');
    check(await count(a)===0&&await count(b)===0&&closes===1,'Confirmed closure clears both device reminders');
    Object.assign(row,{status_key:'open',status_option_key:'open'});
    await a.evaluate(key=>localStorage.setItem(key,JSON.stringify({pending:true,version:0,generation:0,dirty:true})),key);
    await a.reload();await open(a);check(await count(a)===0,'Closing and reopening invalidates an offline first-save version');
    check(sends===0&&ai===0,'Cross-device recovery never sends or generates another email');
    return {checks};
  } finally {for(const context of contexts)await context.close();}
};
