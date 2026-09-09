// Run with scripts/serve-spa.js; provider and API requests are fixtures.
export default async(page, screenshotDir)=>{
 const p=await page.context().newPage(); const user='translation-toggle-'+Date.now();let count=0,fail=false;
 await p.route('**/api/**',r=>r.fulfill({status:200,contentType:'application/json',body:'{}'}));
 await p.route('**/api/v1/ai/messages',async r=>{
  count++;const b=r.request().postDataJSON();let text;
  if(b.action==='detect_language')text='French';
  else try{text=JSON.stringify(JSON.parse(b.messages[0].content).map(t=>'Translated '+t));}catch{text='Translated '+b.messages[0].content;}
  await p.waitForTimeout(70);
  await r.fulfill({status:fail?402:200,contentType:'application/json',body:JSON.stringify(fail?{error:'Not enough AI credit.'}:{text})});
 });
 const setup=async(user)=>{
  const api=await import('/js/core/api-client.js');api.setJwt('toggle-fixture');api.setWorkspaceId('11111111-1111-4111-8111-111111111111');
  window.login('Admin','Toggle Tester','TT',{userId:user});
  const tx=await import('/js/ai/translate.js');tx.setAgentPreferredLang('English');
  const {TICKETS}=await import('/js/core/data.js');const t=TICKETS[0];t.translateThread=false;
  t.msgs=[{_uuid:'customer-1',r:'customer',from:'Customer',t:'Hola mundo',html:'<p>Hola <strong>mundo</strong></p>',ts:'12:00'},
   {_uuid:'agent-1',r:'agent',from:'Agent',t:'Bonjour agent',ts:'12:01'},
   {_uuid:'note-1',r:'note',from:'Agent',t:'Bonjour note',ts:'12:02'}];
  (await import('/js/tickets/detail.js')).openTicket(t.id);return t.id;
 };
 await p.goto('http://localhost:5173');await p.waitForFunction(()=>typeof window.login==='function');
 const id=await p.evaluate(setup,user);let checks=0;const check=(v,m)=>{checks++;if(!v)throw new Error(m+' (requests='+count+')');};
 const toggle=on=>p.evaluate(async({id,on})=>await(await import('/js/ai/translate.js')).toggleThreadTranslate(id,on),{id,on});
 await p.evaluate(async id=>{const tx=await import('/js/ai/translate.js');await Promise.all([tx.toggleThreadTranslate(id,true),tx.toggleThreadTranslate(id,true),tx.toggleThreadTranslate(id,true)]);},id);
 check(count===6,'Repeated clicks should translate each role once');
 check(await p.locator('.ticket-message-language').count()===3,'Whole conversation translated');
 await toggle(false);check(await p.locator('.ticket-message-language').count()===0,'Original hides translations');
 check(await p.evaluate(async()=> (await import('/js/core/data.js')).TICKETS[0].msgs.every(m=>!!m.translation)),'Original retains saved results');
 await toggle(true);check(count===6,'Switching views costs no requests');
 await p.reload();await p.waitForFunction(()=>typeof window.login==='function');await p.evaluate(setup,user);await toggle(true);
 check(count===6,'Refresh reuses persistent translations');
 await p.evaluate(async()=>{const t=(await import('/js/core/data.js')).TICKETS[0];t.msgs[1].t='Changed agent text';});
 await toggle(true);check(count===8,'Only changed message translated');
 await p.evaluate(async()=>{const t=(await import('/js/core/data.js')).TICKETS[0];t.msgs.push({_uuid:'new-1',r:'customer',from:'Customer',t:'New message',ts:'12:03'});(await import('/js/tickets/detail.js')).openTicket(t.id);});
 await p.evaluate(async id=>await(await import('/js/ai/translate.js')).detectAndTranslateThread(id),id);
 check(count===10,'New message translated once');
 await p.evaluate(async()=>{(await import('/js/ai/translate.js')).setAgentPreferredLang('German');});
 await p.evaluate(async id=>await(await import('/js/ai/translate.js')).detectAndTranslateThread(id),id);
 check(count===14,'New language translates four messages');
 await p.evaluate(async()=>{(await import('/js/ai/translate.js')).setAgentPreferredLang('English');});
 await p.evaluate(async id=>await(await import('/js/ai/translate.js')).detectAndTranslateThread(id),id);
 check(count===14,'Returning to saved language costs no requests');
 const before=count;
 await p.evaluate(async()=>{(await import('/js/core/api-client.js')).setWorkspaceId('22222222-2222-4222-8222-222222222222');});
 await toggle(true);check(count===before+8,'Workspace caches isolated');
 await p.evaluate(setup,user+'-other');await toggle(true);check(count===before+14,'Agent caches isolated');
 await p.evaluate(setup,user+'-failure');fail=true;await toggle(true);const failedCount=count;
 check((await p.locator('.ticket-translation-notice').innerText()).includes('Not enough AI credit'),'Provider errors visible');
 await p.waitForTimeout(150);check(count===failedCount,'No automatic paid retry loop');
 fail=false;await toggle(true);check(count===failedCount+6,'Failure is not cached');
 for(const width of [1280,768,390]){
  await p.setViewportSize({width,height:900});const box=await p.locator('.ticket-language-toggle').boundingBox();
  check(box.x>=0&&box.x+box.width<=width,'Language toggle fits '+width);
  check((await p.getByRole('button',{name:'Original',exact:true}).boundingBox()).height>=44,'Toggle touch target '+width);
 }
 await p.getByRole('button',{name:'Original',exact:true}).focus();await p.keyboard.press('Enter');
 check(await p.getByRole('button',{name:'Original',exact:true}).getAttribute('aria-pressed')==='true','Keyboard switches original view');
 check(await p.evaluate(()=>document.activeElement?.dataset.action==='td.originalConversation'),'Keyboard focus survives switching');
 if(screenshotDir) await p.screenshot({path:screenshotDir+'/translation-toggle-390.png'});
 await p.setViewportSize({width:1280,height:900});await toggle(true);await p.waitForTimeout(150);
 if(screenshotDir) await p.screenshot({path:screenshotDir+'/translation-toggle-1280.png'});
 await p.close();return {checks,requests:count};
};
