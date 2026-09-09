// Cross-tab and account-switch fixtures; requires scripts/serve-spa.js.
export default async(page)=>{
 const pages=[await page.context().newPage(),await page.context().newPage()];
 let count=0,resolveSeen,release;let gate=null;const user='cache-concurrency-'+Date.now();
 for(const p of pages){
  await p.route('**/api/**',r=>r.fulfill({status:200,contentType:'application/json',body:'{}'}));
  await p.route('**/api/v1/ai/messages',async r=>{count++;if(resolveSeen)resolveSeen();if(gate)await gate;await r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({text:'Cached translation'})});});
  await p.goto('http://localhost:5173');await p.waitForFunction(()=>typeof window.login==='function');
  await p.evaluate(async user=>{const api=await import('/js/core/api-client.js');api.setJwt('cache-test');api.setWorkspaceId('11111111-1111-4111-8111-111111111111');window.login('Admin','Cache Tester','CT',{userId:user});},user);
 }
 const request=async key=>{const {messageTranslationRequest}=await import('/js/ai/translation-cache.js');return await messageTranslationRequest(key)({system:'Translate to English.',messages:[{role:'user',content:'Bonjour'}],action:'translate',maxTokens:32});};
 await Promise.all(pages.map(p=>p.evaluate(request,'same-message')));
 if(count!==1)throw new Error('Two tabs made duplicate requests: '+count);
 const seen=new Promise(resolve=>resolveSeen=resolve);gate=new Promise(resolve=>release=resolve);
 const pending=pages[0].evaluate(request,'switch-during-request').then(()=>({success:true}),e=>({error:e.message}));
 await seen;
 await pages[0].evaluate(async()=>{(await import('/js/core/api-client.js')).setWorkspaceId('22222222-2222-4222-8222-222222222222');});
 release();const rejected=await pending;
 if(rejected.success||!rejected.error.includes('Workspace changed'))throw new Error('Late workspace response accepted');
 gate=null;resolveSeen=null;
 await pages[0].evaluate(async()=>{(await import('/js/core/api-client.js')).setWorkspaceId('11111111-1111-4111-8111-111111111111');});
 await pages[0].evaluate(request,'switch-during-request');
 if(count!==3)throw new Error('Late response was incorrectly saved');
 await pages[0].evaluate(()=>{window.purgeObserved=new Promise(resolve=>{const c=new BroadcastChannel('respovia-translation-signout');c.onmessage=()=>{c.close();resolve();};});});
 await pages[1].evaluate(async user=>await(await import('/js/ai/translation-cache.js')).clearTranslationCache(user),user);
 await pages[0].evaluate(()=>window.purgeObserved);
 await pages[0].evaluate(request,'same-message');
 if(count!==4)throw new Error('Cross-tab sign-out did not clear memory and storage');
 for(const p of pages)await p.close();return {checks:4,requests:count};
};
