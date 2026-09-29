// Run through the Playwright tool against the local SPA only.
export default async function checkTicketSelectionScroll(page) {
  if (!page.url().startsWith('http://localhost:5173/')) throw new Error('Local fixture only');
  await page.route('**/api/**', route => route.fulfill({json:{}}));
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.setViewportSize({width:1280,height:900});
  const searchesLoaded = page.waitForResponse(response => response.url().includes("/saved-searches"));
  await page.evaluate(async () => {
    window.login('Admin','Selection tester','ST');
    (await import('/js/guides/index.js')).closeGuides(false);
    const {TICKETS}=await import('/js/core/data.js');
    const seed=TICKETS.find(t=>t.status==='open');
    TICKETS.splice(0,TICKETS.length,...Array.from({length:120},(_,i)=>({...seed,id:'SCROLL-'+i,_uuid:null,status:i%2?'open':'pending',subject:'Selection fixture '+i})));
    (await import('/js/core/router.js')).renderPage('tickets');
  });
  await searchesLoaded;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const result=await page.evaluate(async()=>{
    const {TICKET_SELECTED_IDS}=await import('/js/core/state.js');
    const check=(ok,message)=>{if(!ok)throw Error(message);};
    const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const scroller=document.getElementById('ticket-list-scroll'),table=scroller.querySelector('table');
    table.style.minWidth='1800px';
    scroller.scrollTop=900; scroller.scrollLeft=120;
    await settle();
    const boxes=[...scroller.querySelectorAll('[data-change-action="tickets.toggleSelected"]')];
    const box=boxes[25]; box.focus({preventScroll:true});
    const assertStable=async(action,message)=>{
      const before=box.getBoundingClientRect(),left=scroller.scrollLeft;
      action(); await settle();
      check(document.getElementById('ticket-list-scroll')===scroller,message+': scroller replaced');
      check(scroller.querySelector('table')===table,message+': table replaced');
      check(Math.abs(box.getBoundingClientRect().top-before.top)<1,message+': row moved vertically');
      check(scroller.scrollLeft===left,message+': horizontal scroll changed');
    };
    await assertStable(()=>box.click(),'first tick');
    check(document.activeElement===box,'checkbox focus lost');
    check(TICKET_SELECTED_IDS.has(box.dataset.id),'selection not saved');
    check(document.getElementById('ticket-select-all-cb').indeterminate,'partial selection not shown');
    await assertStable(()=>boxes[26].click(),'second tick');
    check(document.getElementById('ticket-selection-count').textContent==='2 selected','count wrong');
    await assertStable(()=>boxes[26].click(),'untick');
    await assertStable(()=>box.click(),'last untick');
    const header=document.getElementById('ticket-select-all-cb');
    await assertStable(()=>header.click(),'select all');
    check(TICKET_SELECTED_IDS.size===120,'select all must cover matching rows beyond visible page');
    check(header.checked&&!header.indeterminate,'select all header wrong');
    await assertStable(()=>document.querySelector('[data-action="tickets.clearSelection"]').click(),'clear selection');
    check(TICKET_SELECTED_IDS.size===0&&!header.checked&&!header.indeterminate,'clear selection incomplete');
    await assertStable(()=>box.click(),'select before bottom');
    scroller.scrollTop=scroller.scrollHeight; await settle();
    await assertStable(()=>box.click(),'last untick at bottom');
    return {checks:'selection, deselection, select all, clear, focus, node identity, vertical/horizontal position, bottom edge'};
  });
  await page.locator('[data-action="tickets.toggleMoreFilters"]').count().then(async count => {
    if (count) await page.locator('[data-action="tickets.toggleMoreFilters"]').click();
  });
  await page.evaluate(() => {
    const group=document.querySelector('[data-change-action="tickets.setGroupBy"]');
    group.value='status'; group.dispatchEvent(new Event('change',{bubbles:true}));
    const scroller=document.getElementById('ticket-list-scroll');
    scroller.scrollTop=800;
    const box=scroller.querySelectorAll('[data-change-action="tickets.toggleSelected"]')[25];
    box.focus({preventScroll:true});
    window.selectionKeyboardFixture={box,scroller,top:box.getBoundingClientRect().top};
  });
  await page.keyboard.press('Space');
  await page.evaluate(() => {
    const {box,scroller,top}=window.selectionKeyboardFixture;
    if (!box.checked || document.activeElement!==box || document.getElementById('ticket-list-scroll')!==scroller
      || Math.abs(box.getBoundingClientRect().top-top)>1) throw Error('Grouped keyboard selection moved the list or lost focus');
    delete window.selectionKeyboardFixture;
  });
  return {...result,groupedKeyboardSelection:'passed'};
}
