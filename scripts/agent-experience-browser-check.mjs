// Synthetic local data only. No live email or contact changes.
export default async (browser, screenshotsDir) => {
  let checks = 0;
  const check = (ok, message) => { checks++; if (!ok) throw Error(message); };
  for (const width of [390, 768, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => route.fulfill({ json: { tickets: [], customers: [], agents: [], roles: [], preferences: {} } }));
    try {
      await page.goto('http://localhost:5173');
      await page.waitForFunction(() => typeof window.login === 'function');
      await page.evaluate(async () => {
        window.login('Admin', 'Experience Tester', 'ET');
        (await import('/js/guides/index.js')).closeGuides(false);
        window.setSettingsTab('display');
      });
      for (const mode of ['dark', 'light', 'system']) {
        await page.locator(`input[name="display_mode"][value="${mode}"]`).check();
        if (mode === 'system') await page.emulateMedia({ colorScheme: 'dark' });
        const expected = mode === 'light' ? 'light' : 'dark';
        await page.waitForFunction(mode => document.getElementById('app').dataset.displayMode === mode, expected);
        for (const scheme of ['violet', 'blue', 'teal']) {
          await page.locator(`input[name="colour_scheme"][value="${scheme}"]`).check();
          const contrast = await page.evaluate(() => {
            const css = getComputedStyle(document.getElementById('app'));
            const luminance = hex => {
              const rgb = hex.replace('#', '').match(/../g).map(x => parseInt(x, 16) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
              return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
            };
            const value = key => luminance(css.getPropertyValue(key).trim());
            const ratio = (a, b) => (Math.max(value(a), value(b)) + .05) / (Math.min(value(a), value(b)) + .05);
            return ['--w', '--off', '--off2'].flatMap(bg => ['--ink', '--ink2', '--ink3', '--ink4'].map(fg => ratio(bg, fg)));
          });
          check(contrast.every(n => n >= 4.5), `${width}: ${mode}/${scheme} text contrast ${contrast}`);
          check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: appearance fits`);
        }
      }
      await page.emulateMedia({ colorScheme: 'light' });
      await page.waitForFunction(() => document.getElementById('app').dataset.displayMode === 'light');
      await page.locator('input[name="display_mode"][value="dark"]').check();
      await page.locator('[data-action="appearance.save"]').click();
      await page.screenshot({ path: `${screenshotsDir}/appearance-dark-${width}.png` });
      await page.evaluate(async () => (await import('/js/tickets/detail.js')).openTicket('TK-001'));
      check(await page.getByRole('button', { name: 'Mark as spam', exact: true }).isVisible(), `${width}: direct spam button visible`);
      await page.screenshot({ path: `${screenshotsDir}/ticket-dark-${width}.png` });
      await page.getByRole('button', { name: 'Mark as spam', exact: true }).click();
      await page.waitForFunction(async () => (await import('/js/core/data.js')).TICKETS.find(t => t.id === 'TK-001').closureReason === 'spam');
      check(await page.locator('.closure-modal').count() === 0, `${width}: no confirmation dialog`);
      await page.locator('.ticket-header-actions [data-action="td.unmarkSpam"]').click();
      check(await page.evaluate(async () => (await import('/js/core/data.js')).TICKETS.find(t => t.id === 'TK-001').status === 'closed'), `${width}: unmark keeps historical ticket closed`);
      await page.evaluate(async () => {
        const state = await import('/js/core/state.js');
        state.TICKET_SELECTED_IDS.add('TK-002'); state.TICKET_SELECTED_IDS.add('TK-003'); state.setCurrentTicket(null);
        (await import('/js/core/router.js')).renderPage('tickets');
      });
      await page.locator('[data-action="tickets.bulkSpam"]').click();
      await page.waitForFunction(async () => (await import('/js/core/data.js')).TICKETS.filter(t => ['TK-002', 'TK-003'].includes(t.id)).every(t => t.closureReason === 'spam'));
      check(await page.locator('.closure-modal').count() === 0, `${width}: bulk is one click`);
      await page.evaluate(async () => { (await import('/js/guides/index.js')).closeGuides(false); });
      await page.locator('[data-action="guides.open"]').first().click();
      await page.locator('[data-module="preferences"]').click();
      await page.locator('[data-action="guides.next"]').click();
      check(await page.locator('.guide-practice-actions .btn-solid:visible').count() === 1, `${width}: one primary action before practice`);
      check(await page.locator('[data-action="guides.confirm"]').isHidden(), `${width}: no premature finish action`);
      await page.locator('input[data-item="notifications"]').check();
      check(await page.locator('.guide-practice-actions .btn-solid:visible').count() === 1, `${width}: one primary action when ready`);
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.guide-practice-actions [data-action="guides.close"]')).backgroundColor === 'rgba(0, 0, 0, 0)');
      await page.screenshot({ path: `${screenshotsDir}/guide-dark-${width}.png` });
      await page.locator('[data-action="guides.confirm"]').click();
      check(await page.locator('.guide-practice-actions .btn-solid:visible').count() === 1, `${width}: one primary action after practice`);
      await page.keyboard.press('Escape');
      await page.evaluate(async () => {
        const data = await import('/js/core/data.js'), state = await import('/js/core/state.js');
        state.setCustomerSelected(data.TICKETS.find(t => t.id === 'TK-001').customerId);
        (await import('/js/core/router.js')).renderPage('customers');
      });
      await page.locator('[data-action="cust.markSpam"]').click();
      check(await page.locator('[data-action="cust.unmarkSpam"]').isVisible(), `${width}: contact mark exposes unmark`);
      await page.locator('[data-action="cust.unmarkSpam"]').click();
      check(await page.locator('[data-action="cust.markSpam"]').isVisible(), `${width}: contact unmark restores action`);
      await page.evaluate(async () => {
        const state = await import('/js/core/state.js'), api = await import('/js/core/api-client.js');
        state.setSession({ ...state.SESSION, userId: 'sound-fixture' }); api.setWorkspaceId('sound-workspace');
        window.setSettingsTab('notifications');
      });
      await page.getByRole('button', { name: 'Test sound', exact: true }).click();
      await page.locator('[data-change-action="sound.toggle"]').check();
      check(await page.evaluate(() => localStorage.getItem('respovia_sound:sound-fixture:sound-workspace') === 'true'), `${width}: sound preference saved`);
      check(errors.length === 0, `${width}: no browser errors: ${errors.join(', ')}`);
    } finally { await context.close(); }
  }
  return { checks };
};
