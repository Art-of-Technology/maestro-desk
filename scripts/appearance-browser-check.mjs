// All network responses are synthetic; no production data or email is touched.
export default async (browser, screenshotsDir) => {
  let checks = 0;
  const check = (ok, message) => { checks++; if (!ok) throw Error(message); };
  for (const width of [320, 390, 768, 1280, 1920]) {
    const height = width === 320 ? 568 : width === 390 ? 844 : 900;
    const context = await browser.newContext({ viewport: { width, height } });
    context.setDefaultTimeout(10000);
    const page = await context.newPage();
    const errors = [], writes = [];
    let saved = { navigation_position: 'left', colour_scheme: 'violet' };
    let failSave = false, failLoad = false, releaseSave;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      if (path === '/api/v1/me') {
        if (req.method() === 'PATCH') {
          writes.push(req.postDataJSON());
          if (failSave) return route.fulfill({ status: 500, json: { error: 'Synthetic save failure' } });
          if (releaseSave === true) await new Promise(resolve => { releaseSave = resolve; });
          saved = { ...saved, ...req.postDataJSON() };
        } else if (failLoad) return route.fulfill({ status: 503, json: { error: 'Synthetic load failure' } });
        return route.fulfill({ json: { user: { id: 'appearance-tester', ...saved } } });
      }
      return route.fulfill({ json: { tickets: [], customers: [], agents: [], roles: [], notifications: [], preferences: {} } });
    });
    const login = () => page.evaluate(async () => {
      const api = await import('/js/core/api-client.js');
      api.setJwt('synthetic-appearance-token'); api.setWorkspaceId('appearance-workspace');
      window.login('Senior Agent', 'Appearance Tester', 'AT', { userId: 'appearance-tester', isAdmin: false,
        permissions: { 'tickets.view_assigned': true, 'tickets.create': true, 'tickets.reply': true, 'customers.view': true } });
      window.setSettingsTab('display');
    });
    const open = () => page.evaluate(() => window.setSettingsTab('display'));
    const choose = (field, value) => page.locator(`.personal-appearance input[name="${field}"][value="${value}"]`).check();
    const painted = (position, scheme) => page.waitForFunction(([p, s]) => {
      const app = document.getElementById('app'); return app.dataset.navigation === p && app.dataset.colourScheme === s;
    }, [position, scheme]);
    const settle = () => page.getByText('All changes saved', { exact: true }).waitFor();
    try {
      await page.goto('http://localhost:5173');
      await page.waitForFunction(() => typeof window.login === 'function');
      await login(); await settle();
      const visibleDestinations = await page.locator('.sb-item:visible').evaluateAll(items => items.map(el => el.dataset.page));
      check(await page.locator('#appearance-save').isDisabled(), `${width}: clean save disabled`);
      for (const position of ['top', 'left']) {
        for (const scheme of ['blue', 'teal', 'violet']) {
          await choose('navigation_position', position); await choose('colour_scheme', scheme);
          await painted(position, scheme);
          check(writes.length === 0, `${width}: preview does not save`);
          check(await page.locator('.personal-appearance input:checked').count() === 2, `${width}: exactly one selection per group`);
          check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: no page overflow`);
          check(await page.locator('#app-sidebar').isVisible(), `${width}: menu visible`);
          check(JSON.stringify(await page.locator('.sb-item:visible').evaluateAll(items => items.map(el => el.dataset.page))) === JSON.stringify(visibleDestinations), `${width}: layout preserves permission-filtered destinations`);
          const contrast = await page.evaluate(() => {
            const style = getComputedStyle(document.getElementById('app'));
            const luminance = hex => {
              const rgb = hex.replace('#', '').match(/../g).map(x => parseInt(x, 16) / 255)
                .map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
              return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
            };
            const colour = key => key.startsWith('#') ? key : style.getPropertyValue(key).trim();
            const ratio = (a, b) => { const x = luminance(colour(a)), y = luminance(colour(b)); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
            return [ratio('--cta', '#ffffff'), ratio('--purple', '--purple-lt'), ratio('--ink', '--w'), ratio('--ink3', '--w'), ratio('--ink4', '--w')];
          });
          check(contrast.every(value => value >= 4.5), `${width}: ${scheme} text, accent and control contrast ${contrast.map(x => x.toFixed(2)).join(', ')}`);
          if (position === 'top') {
            check(await page.locator('#sb-collapse').isHidden(), `${width}: no hidden left-menu toggle target`);
            check(await page.locator('.sb-logo').evaluate(el => el.getAttribute('tabindex') !== '-1'), `${width}: workspace trigger accessible`);
            const navigation = page.locator('.sb-item[data-page="agents"]');
            if (await navigation.isVisible()) {
              await navigation.focus();
              const bounds = await navigation.boundingBox();
              check(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `${width}: keyboard reaches overflow navigation`);
            }
          }
        }
      }
      await choose('navigation_position', 'top'); await choose('colour_scheme', 'teal');
      await page.screenshot({ path: `${screenshotsDir}/appearance-${width}-top-teal.png`, animations: 'disabled' });
      await page.locator('#appearance-cancel').click(); await painted('left', 'violet');
      check(writes.length === 0, `${width}: cancel does not save`);
      await choose('navigation_position', 'top'); await choose('colour_scheme', 'blue');
      await page.evaluate(async () => (await import('/js/core/router.js')).renderPage('tickets'));
      await painted('left', 'violet'); await open();
      check(await page.locator('#appearance-save').isDisabled(), `${width}: navigating discards preview`);
      await choose('navigation_position', 'top'); await choose('colour_scheme', 'teal');
      await page.locator('#appearance-save').click(); await settle();
      check(writes.length === 1 && saved.colour_scheme === 'teal', `${width}: explicit save persisted`);
      await page.locator('.sb-item[data-page="tickets"]').focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.body.dataset.currentPage === 'tickets');
      await painted('top', 'teal');
      check(await page.locator('#app-sidebar').isVisible(), `${width}: saved top menu supports keyboard navigation`);
      await page.evaluate(async () => (await import('/js/tickets/detail.js')).openTicket('TK-001'));
      check(await page.locator('#app-sidebar').isVisible(), `${width}: top navigation remains available in ticket details`);
      await open();
      await page.reload(); await page.waitForFunction(() => typeof window.login === 'function');
      await login(); await settle(); await painted('top', 'teal');
      check(await page.locator('input[name="navigation_position"][value="top"]').isChecked(), `${width}: reload restores server selection`);
      // Native radio arrow-key behaviour and visible focus survive previews.
      const blue = page.locator('input[name="colour_scheme"][value="blue"]');
      await blue.focus(); await page.keyboard.press('ArrowLeft'); await painted('top', 'violet');
      check(await page.locator('input[name="colour_scheme"][value="violet"]').evaluate(el => el === document.activeElement), `${width}: keyboard selection retains focus`);
      failSave = true;
      await page.locator('#appearance-save').click();
      await page.getByText('Couldn’t save your appearance. Please try again.', { exact: true }).waitFor();
      check(saved.colour_scheme === 'teal', `${width}: failure preserves saved choice`);
      check(await page.locator('#appearance-save').isEnabled(), `${width}: failure can retry`);
      await page.locator('#appearance-cancel').click(); await painted('top', 'teal');
      failSave = false;
      await page.locator('[data-action="appearance.defaults"]').click(); await painted('left', 'violet');
      check(saved.colour_scheme === 'teal', `${width}: defaults require save`);
      await page.locator('#appearance-save').click(); await settle();
      check(saved.navigation_position === 'left' && saved.colour_scheme === 'violet', `${width}: defaults persist`);
      // Delayed saves cannot repaint a signed-out or replacement account.
      releaseSave = true;
      await choose('navigation_position', 'top'); await choose('colour_scheme', 'blue');
      await page.locator('#appearance-save').click();
      await page.waitForFunction(() => document.getElementById('appearance-status')?.textContent === 'Saving…');
      while (releaseSave === true) await new Promise(resolve => setTimeout(resolve, 10));
      await page.evaluate(() => window.logout({ force: true }));
      releaseSave(); releaseSave = undefined;
      await page.waitForResponse(res => res.url().endsWith('/api/v1/me') && res.request().method() === 'PATCH');
      await painted('left', 'violet');
      check(await page.locator('#app').isHidden(), `${width}: save completion cannot reopen signed-out app`);
      failLoad = true;
      await login();
      await page.getByText('Couldn’t load your appearance settings.', { exact: false }).waitFor();
      check(await page.locator('#appearance-save').isDisabled(), `${width}: failed load cannot overwrite account`);
      failLoad = false;
      await page.locator('[data-action="appearance.retry"]').click(); await settle(); await painted('top', 'blue');
      check(errors.length === 0, `${width}: no JavaScript errors: ${errors.join(', ')}`);
    } finally { await context.close(); }
  }
  return { checks, viewports: 5 };
};
