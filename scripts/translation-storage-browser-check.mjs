// Storage failure, sign-out and same-language browser fixtures.
export default async(page)=>{
 let checks=0,requests=0;const check=(v,m)=>{checks++;if(!v)throw new Error(m);};
 for(const mode of ['normal','blocked','quota']){
  const p=await page.context().newPage();const user='storage-'+mode+'-'+Date.now();
  if(mode==='blocked')await p.addInitScript(()=>Object.defineProperty(window,'indexedDB',{get(){throw new Error('Storage blocked');}}));
  if(mode==='quota')await p.addInitScript(()=>{IDBObjectStore.prototype.put=function(){throw new DOMException('Full','QuotaExceededError');};});
  await p.route('**/api/**',r=>r.fulfill({status:200,contentType:'application/json',body:'{}'}));
  await p.route('**/api/v1/ai/messages',r=>{requests++;const b=r.request().postDataJSON();return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({text:b.action==='detect_language'?(b.messages[0].content.includes('Hello')?'English':'French'):'Hello customer'})});});
  await p.goto('http://localhost:5173');await p.waitForFunction(()=>typeof window.login==='function');
  const result=await p.evaluate(async({user,mode})=>{
   const api=await import('/js/core/api-client.js');api.setJwt('storage-fixture');api.setWorkspaceId('11111111-1111-4111-8111-111111111111');window.login('Admin','Storage Tester','ST',{userId:user});
   const tx=await import('/js/ai/translate.js');tx.setAgentPreferredLang('English');
   const t=(await import('/js/core/data.js')).TICKETS[0];
   t.msgs=[{_uuid:'customer',r:'customer',from:'Customer',t:'Bonjour client',ts:'12:00'},
    {_uuid:'agent',r:'agent',from:'Agent',t:'Hola cliente',tOriginal:'Hello customer',translatedTo:'Spanish',ts:'12:01'},
    {_uuid:'note',r:'note',from:'Agent',t:'Hello note',ts:'12:02'}];
   (await import('/js/tickets/detail.js')).openTicket(t.id);await tx.toggleThreadTranslate(t.id,true);
   const detected=t.detectedCustomerLang,translated=t.msgs.every(m=>tx.hasMessageTranslation(m));
   await tx.toggleThreadTranslate(t.id,false);
   const original=document.querySelector('.msg-agent').innerText;
   const sentLink=!!document.querySelector('[data-action="td.showSentText"]');
   await tx.toggleThreadTranslate(t.id,true);
   return {detected,translated,original,sentLink,warning:document.querySelector('.ticket-translation-notice').innerText};
  },{user,mode});
  check(result.translated,'Translation works in '+mode);
  check(result.detected==='French','Customer language detected in '+mode);
  check(result.original.includes('Hello customer')&&result.sentLink,'Composed original and sent-text link retained');
  check(requests===4*(mode==='normal'?1:mode==='blocked'?2:3),'Same-language note skips generation and toggle is free');
  if(mode!=='normal')check(result.warning.includes('Could not save translations'),'Storage limitation is visible');
  if(mode==='normal'){
   const countForUser=()=>p.evaluate(async user=>{const db=await new Promise(resolve=>{const r=indexedDB.open('respovia-translations',1);r.onsuccess=()=>resolve(r.result);});return await new Promise(resolve=>{const r=db.transaction('responses').objectStore('responses').count(IDBKeyRange.bound(encodeURIComponent(user)+':',encodeURIComponent(user)+':\uffff'));r.onsuccess=()=>resolve(r.result);});},user);
   check(await countForUser()===4,'Language and translation results saved');
   await p.evaluate(async()=>await window.logout());
   check(await countForUser()===0,'Sign-out purges persistent translations');
  }
  await p.close();
 }
 return {checks,requests};
};
