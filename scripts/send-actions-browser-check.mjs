// Synthetic local API/provider fixtures; no real messages or surveys.
export default async (browser, screenshotsDir) => {
  let checks = 0;
  const check = (ok, message) => { checks++; if (!ok) throw Error(message); };
  const labels = ['Send', 'Send & resolve', 'Send & close', 'Send & pending', 'Send & escalate'];
  for (const scenario of ['resolved', 'pending', 'escalated', 'custom-review', 'retry', 'unconfirmed']) {
    const context = await browser.newContext({ viewport: { width: scenario === 'retry' ? 390 : 1280, height: 900 } });
    context.setDefaultTimeout(10000);
    const page = await context.newPage();
    console.log('Send action scenario:', scenario);
    try {
      const id = '11111111-1111-4111-8111-111111111111', customerId = '22222222-2222-4222-8222-222222222222';
      const target = ['retry', 'unconfirmed'].includes(scenario) ? 'resolved' : scenario;
      const statuses = ['open', 'resolved', 'closed', 'pending', 'escalated', 'gdpr', 'custom-review'].map(key => ({
        key, label: key, base_key: key === 'custom-review' ? 'pending' : key, is_active: true,
        send_survey: key === 'resolved', reason_required: key === 'custom-review',
        reasons: key === 'custom-review' ? [{ key: 'review', label: 'Review', is_active: true }] : [],
      }));
      const row = { id, display_id: 'TK-ACTIONS', customer_id: customerId, subject: 'Synthetic send actions', status_key: 'open', status_option_key: 'open', status_survey_enabled: false, priority_key: 'normal' };
      const messages = [], drafts = {};
      let creates = 0, updates = 0;
      page.on('dialog', dialog => dialog.accept());
      await page.route('**/api/**', async route => {
        const req = route.request(), path = new URL(req.url()).pathname, body = req.postDataJSON();
        let json = {}, status = 200;
        if (path.endsWith('/close-reminder')) json = { reminder: { pending: !!body?.pending, version: body?.version != null ? body.version + 1 : 0, generation: 0 } };
        else if (path.endsWith('/ticket-statuses')) json = { statuses };
        else if (path.endsWith('/customers/' + customerId) && req.method() === 'PATCH') json = { customer: { preferred_language: body.preferred_language } };
        else if (path.endsWith('/ai/messages')) json = { text: body.action === 'detect_language' ? 'English' : 'Synthetic message' };
        else if (path.endsWith('/tickets') && req.method() === 'POST') { creates++; Object.assign(row, body); json = { ticket: row }; }
        else if (path.endsWith('/messages') && req.method() === 'POST') {
          const message = { id: 'message-' + messages.length, role: 'agent', body: body.body, created_at: new Date().toISOString() };
          messages.push(message); json = { message, delivery: { emailed: scenario !== 'unconfirmed', reason: scenario === 'unconfirmed' ? 'delivery_unconfirmed' : 'sent' } };
        } else if (path.includes('/drafts/')) {
          const tab = path.split('/').at(-1);
          if (req.method() === 'PUT') drafts[tab] = { ...body, version: (body.version || 0) + 1, attachments: [] };
          json = { draft: drafts[tab] || { body: '', is_html: false, recipients: null, review: null, attachments: [], version: 0 } };
        } else if (path.endsWith('/tickets/' + id) && req.method() === 'PATCH') {
          updates++;
          if (scenario === 'retry' && updates === 1) { status = 503; json = { error: 'Synthetic status failure' }; }
          else {
            const choice = statuses.find(s => s.key === body.status_option_key);
            Object.assign(row, { status_key: choice.base_key, status_option_key: choice.key, status_survey_enabled: choice.send_survey });
            json = { ticket: row, activity: [], survey: choice.send_survey ? { sent: true } : undefined };
          }
        } else if (path.endsWith('/tickets/' + id)) json = { ticket: { ...row, messages, activity: [], reply_recipients: { to: ['fixture@example.test'], cc: [], sending_inboxes: [], source_message_id: null } } };
        await route.fulfill({ status, json });
      });
      await page.goto('http://localhost:5173');
      await page.waitForFunction(() => typeof window.login === 'function');
      await page.evaluate(async customerId => {
        window.login('Admin', 'Synthetic tester', 'ST', { userId: 'send-action-tester' });
        const data = await import('/js/core/data.js'), api = await import('/js/core/api-client.js');
        api.setJwt('fixture'); api.setWorkspaceId('33333333-3333-4333-8333-333333333333');
        data.CUSTOMERS[0]._uuid = customerId; data.CUSTOMERS[0].preferredLanguage = 'English';
        if (!data.CATEGORIES.length) data.CATEGORIES.push({ key: 'general', label: 'General', is_active: true });
        await (await import('/js/tickets/new-ticket.js')).showNewTicketModal(null, data.CUSTOMERS[0].id);
      }, customerId);
      await page.locator('#nt-subj').fill('Synthetic send actions'); await page.locator('#nt-cat').selectOption({ index: 1 });
      await page.locator('[data-action="modal.confirm"]').click();
      await page.getByRole('button', { name: 'Confirm and continue', exact: true }).click();
      await page.locator('#nt2-after-send').waitFor();
      const withoutAIHint = 'Sends your message as written, without AI translation. The subject, header, signature and footer keep their saved wording. Check the language before sending.';
      check(await page.locator('#nt2-without-ai-hint').textContent() === withoutAIHint, 'New-ticket form explains sending without AI');
      check(await page.locator('#nt2-without-ai-btn').getAttribute('aria-describedby') === 'nt2-without-ai-hint', 'New-ticket button exposes its explanation to screen readers');
      const withoutAIButtonBounds = await page.locator('#nt2-without-ai-btn').boundingBox();
      const withoutAIHintBounds = await page.locator('#nt2-without-ai-hint').boundingBox();
      check(withoutAIHintBounds.y >= withoutAIButtonBounds.y + withoutAIButtonBounds.height, 'New-ticket explanation sits below its button');
      const choices = await page.locator('#nt2-after-send option').allTextContents();
      check(JSON.stringify(choices.slice(0, 5)) === JSON.stringify(labels), 'New-ticket actions have the agreed labels and order: '+JSON.stringify(choices));
      await page.locator('#nt2-msg').fill('Synthetic message'); await page.locator('#nt2-after-send').selectOption(target);
      if (target === 'custom-review') await page.locator('#nt2-close-reason').selectOption('review');
      check(await page.locator('#nt2-msg').inputValue() === 'Synthetic message', 'Changing action preserves message');
      if (screenshotsDir && scenario === 'pending') { await page.locator('#nt2-without-ai-hint').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${screenshotsDir}/new-ticket-send-actions-1280.png` }); }
      await page.locator('[data-action="modal.confirm"]').click();
      await page.locator('#nt2-msg').waitFor({ state: 'detached' });
      if (scenario === 'retry') {
        await page.getByRole('button', { name: 'Retry status only', exact: true }).waitFor();
        check(creates === 1 && messages.length === 1 && updates === 1, 'Failed status update does not resend or recreate');
        check(await page.getByRole('dialog', { name: 'Message sent. Status not updated.', exact: true }).count() === 1, 'Retry dialog has an accessible name');
        await page.keyboard.press('Tab');
        check(await page.getByRole('button', {name:'Close dialog', exact:true}).evaluate(el => el === document.activeElement), 'Retry dialog keeps forward keyboard focus inside');
        await page.keyboard.press('Shift+Tab');
        check(await page.getByRole('button', {name:'Retry status only', exact:true}).evaluate(el => el === document.activeElement), 'Retry dialog keeps backward keyboard focus inside');
        if (screenshotsDir) await page.screenshot({ path: `${screenshotsDir}/send-status-retry-390.png` });
        await page.getByRole('button', { name: 'Retry status only', exact: true }).click();
        await page.getByRole('button', { name: 'Retry status only', exact: true }).waitFor({ state: 'hidden' });
        check(creates === 1 && messages.length === 1 && updates === 2, 'Retry changes status only');
      }
      await page.waitForFunction(expected => document.querySelector('[aria-label="Ticket status"]')?.value === expected, scenario === 'unconfirmed' ? 'open' : target);
      check(messages.length === 1 && creates === 1, 'First-message action sends and creates exactly once');
      check(updates === (scenario === 'unconfirmed' ? 0 : scenario === 'retry' ? 2 : 1), 'Only confirmed sending permits the selected status update');
      check(row.status_survey_enabled === (scenario !== 'unconfirmed' && target === 'resolved'), 'Only resolved uses the survey policy');
      if (scenario === 'unconfirmed') continue;
      await page.getByRole('button', { name: 'Reply', exact: true }).click();
      await page.locator('[aria-label="More send options"]').click();
      const menu = page.locator('#send-menu-TK-ACTIONS');
      const text = await menu.locator('[data-action="td.sendAnd"], [data-action="td.send"]').locator('span').allTextContents();
      check(JSON.stringify(text.slice(0, 5)) === JSON.stringify(labels), 'Reply menu uses the same five labels and order');
      check(await menu.locator('[data-status="custom-review"]').count() === 1, 'Custom status action stays available');
      check(await menu.getByText('Keeps the current status. No survey.', { exact: true }).count() === 1, 'Send explains current-status preservation');
      const described = await menu.getByRole('button', { name: 'Send & resolve', exact: true }).getAttribute('aria-describedby');
      check(await page.locator('[id="' + described + '"]').textContent() === 'Marks resolved. Surveys follow the brand’s rules.', 'Action hint is exposed as the screen-reader description');
      const withoutAI = menu.locator('[data-action="td.sendWithoutAI"]');
      check(await withoutAI.locator('small').textContent() === withoutAIHint, 'Reply menu uses the same explanation');
      const withoutAIDescription = await withoutAI.getAttribute('aria-describedby');
      check(await page.locator('[id="' + withoutAIDescription + '"]').textContent() === withoutAIHint, 'Reply option exposes the explanation to screen readers');
      const bounds = await menu.boundingBox();
      check(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= page.viewportSize().width && bounds.y + bounds.height <= page.viewportSize().height, 'Send menu stays within the viewport');
      const targets = await menu.locator('button').evaluateAll(items => items.map(el => el.getBoundingClientRect().height));
      check(targets.every(height => height >= 44), 'Send actions meet the 44px touch target');
      if (screenshotsDir && ['pending', 'retry'].includes(scenario)) await page.screenshot({ path: `${screenshotsDir}/reply-send-actions-${page.viewportSize().width}.png` });
      await page.locator('[aria-label="More send options"]').click();
      const before = row.status_option_key, beforeUpdates = updates;
      await page.locator('#compose-TK-ACTIONS .ql-editor').fill('Synthetic follow-up');
      const reply = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/tickets/' + id + '/messages') && r.request().method() === 'POST', {timeout: 10000});
      await page.locator('.composer-send').click();
      await reply.catch(async error => { console.log(await page.locator('body').innerText()); throw error; });
      check(messages.length === 2, scenario+': Plain Send sends the follow-up once ('+messages.length+')');
      check(updates === beforeUpdates && row.status_option_key === before, 'Plain Send preserves the existing status');
    } finally { await context.close(); }
  }
  return { checks };
};
