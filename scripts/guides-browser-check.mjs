// Synthetic browser checks only; guides must never write to application APIs.
export default async (browser, screenshotsDir) => {
  let checks = 0;
  const check = (ok, message) => { checks++; if (!ok) throw Error(message); };
  const base = ['tickets.view_assigned','tickets.create','tickets.reply','tickets.note','tickets.attach','tickets.assign','tickets.edit','tickets.close','customers.view','customers.contact_add','customers.contact_primary','customers.contact_remove','tools.ai'];
  for (const width of [320,390,768,1280]) {
    const height = width === 320 ? 568 : width === 390 ? 844 : 900;
    const context = await browser.newContext({viewport:{width,height}});
    context.setDefaultTimeout(10000);
    const page = await context.newPage();
    const writes = [], errors=[];
    page.on('pageerror', error=>errors.push(error.message));
    await page.route('**/api/**',route=>{
      if(!route.request().url().startsWith('https://tagline.cipiti.ai/') && !['GET','OPTIONS'].includes(route.request().method())) writes.push(route.request().url());
      return route.fulfill({json:{tickets:[],customers:[],agents:[],roles:[],notifications:[],preferences:{}}});
    });
    const open = async()=>{
      await page.evaluate(async()=>{ const guides=await import('/js/guides/index.js'); guides.closeGuides(false); });
      await page.locator('[data-action="guides.open"]').first().click();
    };
    try {
      await page.goto('http://localhost:5173');
      await page.waitForFunction(()=>typeof window.login==='function');
      const login = () => page.evaluate(async permissions=>{
        window.login('Senior Agent','Synthetic guide tester','GT',{userId:'guide-tester',isAdmin:false,permissions:Object.fromEntries(permissions.map(key=>[key,true]))});
        const api=await import('/js/core/api-client.js'); api.setWorkspaceId('guide-fixture');
      },base);
      await login();
      await open();
      check(await page.locator('[data-action="guides.module"]').count()===6,`${width}: agent has six modules`);
      check(!await page.getByRole('button',{name:/Brand administration/}).count(),`${width}: no administration for agent`);
      const bounds=await page.locator('.guide-menu').boundingBox();
      check(bounds.x>=0 && bounds.x+bounds.width<=width && bounds.y>=0 && bounds.y+bounds.height<=height,`${width}: menu fits viewport`);
      await page.locator('[data-module="preferences"]').click();
      await page.getByRole('heading',{name:'Choose notification preferences'}).waitFor();
      check(await page.locator('[data-guide-ready]').count()===1,`${width}: actual settings target found`);
      await page.screenshot({path:`${screenshotsDir}/guides-${width}-step.png`});
      const stepBounds=await page.locator('.guide-card').boundingBox();
      check(stepBounds.x>=0 && stepBounds.x+stepBounds.width<=width && stepBounds.y>=0 && stepBounds.y+stepBounds.height<=height,`${width}: step fits viewport`);
      await page.keyboard.press('Escape');
      await page.reload(); await page.waitForFunction(()=>typeof window.login==='function'); await login();
      await open(); await page.locator('[data-action="guides.resume"]').click();
      check(await page.locator('#guide-title').textContent()==='Choose notification preferences',`${width}: resume exact step`);
      await page.locator('[data-action="guides.next"]').click();
      check(await page.locator('[data-action="guides.confirm"]').isDisabled(),`${width}: no automatic practice confirmation`);
      await page.locator('input[data-item="notifications"]').check();
      await page.locator('[data-action="guides.confirm"]').click();
      check(await page.locator('.guide-complete').textContent()==='✓ Practice confirmed by you',`${width}: explicit confirmation recorded`);
      await page.screenshot({path:`${screenshotsDir}/guides-${width}-practice.png`});
      await page.locator('input[data-item="notifications"]').uncheck();
      check(await page.locator('[data-action="guides.confirm"]').isDisabled(),`${width}: unchecking withdraws confirmation`);
      await page.keyboard.press('Escape'); await open();
      await page.screenshot({path:`${screenshotsDir}/guides-${width}-menu.png`});
      await page.keyboard.press('/');
      check(await page.locator('.guide-menu').evaluate(el=>el.contains(document.activeElement)),`${width}: search shortcut keeps modal focus`);
      await page.keyboard.press('Control+k');
      check(await page.locator('#quick-switcher').count()===0,`${width}: switcher cannot open under guide`);
      check(await page.locator('#main-area').evaluate(el=>!!el.closest('[inert]')),`${width}: background is inert`);
      const dialog=page.getByRole('dialog');
      const buttons=dialog.locator('button:visible:not([disabled])');
      await buttons.last().focus(); await page.keyboard.press('Tab');
      check(await buttons.first().evaluate(el=>el===document.activeElement),`${width}: focus wraps forward`);
      await page.keyboard.press('Shift+Tab');
      check(await buttons.last().evaluate(el=>el===document.activeElement),`${width}: focus wraps backward`);
      for (const moduleId of ['navigation','creation','replies','customers','handovers']) {
        await page.locator(`[data-module="${moduleId}"]`).click();
        for(let count=0;count<12 && !await page.locator('.guide-practice').count();count++) {
          await page.locator('[data-guide-ready]').waitFor();
          await page.locator('[data-action="guides.next"]').click();
        }
        check(await page.locator('.guide-practice').count()===1,`${width}: ${moduleId} reaches practice`);
        check(await page.locator('[data-action="guides.confirm"]').isDisabled(),`${width}: ${moduleId} requires own confirmation`);
        await page.locator('[data-action="guides.continue"]').click();
      }
      // Missing target: force an unavailable screen without changing application data.
      await page.locator('[data-module="preferences"]').click();
      await page.evaluate(async()=>{
        document.querySelector('[data-guide="preferences"]').removeAttribute('data-guide');
        (await import('/js/guides/index.js')).guidePageRendered('settings');
      });
      check(await page.locator('.guide-warning').count()===1,`${width}: missing target remains actionable`);
      await page.getByRole('button',{name:'Skip →',exact:true}).click();
      await page.keyboard.press('Escape');
      await page.evaluate(async()=>{
        const state=await import('/js/core/state.js'); state.setSession({...state.SESSION,isAdmin:true});
      });
      await open();
      check(await page.locator('[data-action="guides.module"]').count()===7,`${width}: admin has seven modules`);
      await page.locator('[data-module="administration"]').click();
      await page.locator('[data-guide-ready]').waitFor();
      await page.locator('[data-action="guides.next"]').click();
      await page.getByRole('heading',{name:'Tailor role permissions'}).waitFor();
      check(await page.locator('[data-guide-ready]').count()===1,`${width}: roles target found`);
      await page.keyboard.press('Escape');
      // Restricted custom role: no ticket/customer/admin modules, even with an admin-like name.
      await page.evaluate(async()=>{
        const state=await import('/js/core/state.js'); state.setSession({...state.SESSION,role:'Custom Admin',isAdmin:false,permissions:{}});
      });
      await open();
      check(await page.locator('[data-action="guides.module"]').count()===3,`${width}: custom role follows saved grants`);
      check(writes.length===0,`${width}: guides made no application writes: ${writes.join(',')}`);
      check(errors.length===0,`${width}: no browser exceptions: ${errors.join(',')}`);
    } finally { await context.close(); }
  }
  return {checks};
};
