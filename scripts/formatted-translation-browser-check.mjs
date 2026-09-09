// Isolated browser fixtures; run with scripts/serve-spa.js.
export default async(page)=>{
 const p=await page.context().newPage();
 await p.route('**/api/**',r=>r.fulfill({status:200,contentType:'application/json',body:'{}'}));
 const requests=[];
 await p.route('**/api/v1/ai/messages',async r=>{
  const b=r.request().postDataJSON();requests.push(b);
  let text;
  if(b.action==='detect_language')text='Spanish';
  else {try{text=JSON.stringify(JSON.parse(b.messages[0].content).map(t=>t.replaceAll('Hola','Hello').replaceAll('mundo','world')));}catch{text='Hello\n\nSecond paragraph';}}
  await r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({text})});
 });
 await p.goto('http://localhost:5173');
 await p.waitForFunction(()=>typeof window.login==='function');
 const result=await p.evaluate(async()=>{
  let checks=0; const assert=(v,m)=>{checks++;if(!v)throw new Error(m);};
  const {translateFormatted}=await import('/js/ai/formatted-translation.js');
  const html='<p style="color:red">Hola <strong>mundo</strong>!</p><ul><li>Hola</li></ul><a href="https://example.com">Hola</a><img src="https://example.com/pixel.png"><table><tbody><tr><td>Hola</td></tr></tbody></table>';
  const r=await translateFormatted(html,'English',async b=>({text:JSON.stringify(JSON.parse(b.messages[0].content).map(t=>t.replaceAll('Hola','Hello').replaceAll('mundo','world')))}));
  const d=document.createElement('template');d.innerHTML=r.translationHtml;
  assert(d.content.querySelector('strong').textContent==='world','Bold text translated');
  assert(d.content.querySelector('p').getAttribute('style')==='color:red','Style retained');
  assert(d.content.querySelector('a').getAttribute('href')==='https://example.com','Link retained');
  assert(d.content.querySelector('li').textContent==='Hello'&&d.content.querySelector('td').textContent==='Hello','Lists and tables retained');
  const hostile=await translateFormatted('<p>Hola</p>','English',async()=>({text:JSON.stringify(['<img src=x onerror=alert(1)>'])}));
  assert(!hostile.translationHtml.includes('<img'),'Model markup must remain text');
  let failed=false;try{await translateFormatted('<p>Hola <b>mundo</b></p>','English',async()=>({text:'["only one"]'}));}catch{failed=true;}
  assert(failed,'Incomplete output rejected');
  const spaced=await translateFormatted('<p> Hola <b>mundo</b> ! </p>','English',async()=>({text:JSON.stringify(['Hello','world','!'])}));
  assert(spaced.translationHtml==='<p> Hello <b>world</b> ! </p>','Whitespace at formatting boundaries retained');
  let malformed=false;try{await translateFormatted('<p>Hola</p>','English',async()=>({text:'invalid JSON'}));}catch{malformed=true;}
  assert(malformed,'Malformed output rejected');
  let calls=0;try{await translateFormatted('<p>Hola</p><p>'+ 'x'.repeat(4001)+'</p>','English',async()=>{calls++;return {text:'[]'};});}catch{}
  assert(calls===0,'Oversized node fails before any requests');
  let batches=0;await translateFormatted('<p>Hola</p>'.repeat(81),'English',async b=>{batches++;return {text:b.messages[0].content};});
  assert(batches===3,'Large messages batched');
  const api=await import('/js/core/api-client.js');api.setJwt('translation-fixture');api.setWorkspaceId('11111111-1111-4111-8111-111111111111');
  window.login('Admin','Translation Tester','TT',{userId:'translation-test'});
  const {TICKETS}=await import('/js/core/data.js');const t=TICKETS[0];
  t.msgs=[{r:'customer',from:'Test',t:'Hola mundo!',html,ts:'12:00'}];
  const {openTicket}=await import('/js/tickets/detail.js');openTicket(t.id);
  const tx=await import('/js/ai/translate.js');tx.setAgentPreferredLang('English');await tx.translateMessage(t.id,0);
  assert(t.msgs[0].translationHtml.includes('<strong>world</strong>'),'Individual message uses formatted translation');
  assert(document.querySelectorAll('iframe[data-msg-frame]').length===1,'Conversation renders one translated frame');
  const frame=[...document.querySelectorAll('iframe[data-msg-frame]')].at(-1);
  assert(!frame.getAttribute('sandbox').includes('allow-scripts'),'Translated frame cannot execute scripts');
  assert(frame.srcdoc.includes("default-src 'none'")&&!frame.srcdoc.includes('img-src data: https:'),'Remote images remain blocked');
  t.translateThread=true;t.detectedCustomerLang='Spanish';openTicket(t.id);
  assert(document.querySelectorAll('iframe[data-msg-frame]').length===1,'Thread uses single translated frame');
  tx.hideMessageTranslation(t.id,0);assert(!!t.msgs[0].translationHtml&&!t.translateThread,'Original retains rich result');
  await tx.toggleThreadTranslate(t.id,true);
  assert(t.msgs[0].translationHtml.includes('<strong>world</strong>'),'Thread generates formatted translation');
  t.translateThread=false;t.msgs[0].html=null;delete t.msgs[0].translationHtml;delete t.msgs[0].translation;openTicket(t.id);
  await tx.translateMessage(t.id,0);
  const block=document.querySelector('.msg-customer');
  assert(block.innerHTML.includes('Hello<br><br>Second paragraph'),'Plain translation preserves line breaks');
  return {checks,ticket:t.id};
 });
 await p.close();return {...result,requests:requests.length};
};
