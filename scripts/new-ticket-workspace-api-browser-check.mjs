// Synthetic local API only. Exercise the production save/send contract in a browser.
export default async function checkWorkspaceApi(browser) {
  let checks = 0;
  const check = (ok, message) => { if (!ok) throw Error(message); checks++; };
  for (const scenario of ['busy-shortcut', 'hidden-message', 'empty-draft', 'rich-draft', 'draft-retry', 'send', 'create-failed', 'plain-fallback', 'loading-editor', 'restricted', 'scope-change', 'ai', 'ai-edited', 'ai-failed', 'ai-label', 'ai-rerender']) {
    console.log('CHECK ticket workspace: ' + scenario);
    const context = await browser.newContext(), page = await context.newPage();
    const errors = [], requests = [], drafts = {};
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    const id = '11111111-1111-4111-8111-111111111111', customerId = '22222222-2222-4222-8222-222222222222', channelId = '55555555-5555-4555-8555-555555555555';
    const row = { id, display_id: 'TK-WORKSPACE', customer_id: customerId, status_key: 'open', priority_key: 'high' };
    let failDraft = scenario === 'draft-retry', creates = 0, messages = 0, releaseEditor, releaseAi, releaseCreate;
    if (scenario === 'plain-fallback') await page.route('**/vendor/quill.js', route => route.abort());
    if (scenario === 'loading-editor') await page.route('**/vendor/quill.js', async route => { await new Promise(resolve => { releaseEditor = resolve; }); await route.continue(); });
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname, body = request.postDataJSON();
      requests.push({ path, method: request.method(), body });
      let status = 200, json = {};
      if (path.endsWith('/ai/messages')) {
        if (['ai-edited','ai-rerender'].includes(scenario)) await new Promise(resolve => { releaseAi = resolve; });
        if (scenario === 'ai-failed') { status = 503; json = { error: 'Synthetic AI unavailable' }; }
        else json = { text: 'Customer suggestion only.', internal: { notes: ['Private agent note.'], references: [] } };
      }
      else if (path.endsWith('/channels/sending-inboxes')) json = { inboxes: [{ id: channelId, address: 'support@example.test' }] };
      else if (path.endsWith('/ticket-statuses')) json = { statuses: ['open','pending','resolved','escalated','closed'].map(key => ({ key, label: key, base_key: key, is_active: true, reasons: [], send_survey: key === 'resolved' })) };
      else if (path.endsWith('/tickets') && request.method() === 'POST') {
        if (scenario === 'busy-shortcut') await new Promise(resolve => { releaseCreate = resolve; });
        creates++; Object.assign(row, body); json = { ticket: row };
        if (['create-failed','ai-label'].includes(scenario)) { status = 503; json = { error: 'Synthetic create failure' }; }
      } else if (path.includes('/drafts/')) {
        const tab = path.split('/').at(-1);
        if (request.method() === 'PUT') {
          check(typeof body.recipients.cc === 'string', 'Personal draft Cc uses the server string contract');
          if (failDraft) { status = 503; json = { error: 'Synthetic draft failure' }; }
          else drafts[tab] = { ...body, version: body.version + 1, attachments: [] };
        }
        if (status === 200) json = { draft: drafts[tab] || { body: '', recipients: null, review: null, attachments: [], version: 0 } };
      } else if (path.endsWith('/messages') && request.method() === 'POST') {
        messages++;
        check(body.email_recipients.sending_channel_id === channelId && body.email_recipients.sending_address === 'support@example.test', 'Sending includes the verified sender identity');
        check(Array.isArray(body.email_recipients.cc), 'Outgoing Cc uses the server array contract');
        check(body.body_html.includes('<strong>') && !body.body_html.includes('{ticket}'), 'Send retains formatting and replaces the real ticket reference');
        drafts.reply = { body: '', recipients: null, review: null, attachments: [], version: body.draft_version + 1 };
        json = { message: { id: 'synthetic', role: 'agent', body: body.body }, draft_version: drafts.reply.version, delivery: { emailed: true } };
      } else if (path.endsWith('/tickets/' + id)) json = { ticket: { ...row, messages: [], activity: [], reply_recipients: { to: ['synthetic@example.test'], cc: [], sending_inboxes: [{ id: channelId, address: 'support@example.test' }], source_message_id: null } } };
      await route.fulfill({ status, json });
    });
    try {
      await page.goto('http://localhost:5173');
      await page.waitForFunction(() => typeof window.login === 'function');
      await page.evaluate(async ({ customerId, channelId, scenario }) => {
        window.login('Admin', 'Synthetic workspace tester', 'WT', { userId: 'workspace-' + scenario });
        const api = await import('/js/core/api-client.js'), data = await import('/js/core/data.js');
        api.setJwt('synthetic'); api.setWorkspaceId('33333333-3333-4333-8333-333333333333');
        Object.assign(data.CUSTOMERS[0], { _uuid: customerId, email: 'synthetic@example.test', preferredLanguage: 'English' });
        data.CATEGORIES.push({ key: 'general', label: 'General', is_active: true });
        data.CHANNELS.push({ _uuid: channelId, id: 'CH-TEST', type: 'email', status: 'active', address: 'support@example.test' });
        (await import('/js/layouts/index.js')).getLayoutFields('ticket').find(f => f.key === 'message').required = true;
        if (scenario === 'hidden-message') (await import('/js/layouts/index.js')).getLayoutFields('ticket').find(f => f.key === 'message').visible = false;
        if (scenario === 'restricted') {
          const state = await import('/js/core/state.js'); state.setSession({ ...state.SESSION, permissions: { 'tickets.create': true } });
        }
        await (await import('/js/tickets/new-ticket.js')).showNewTicketModal(null, data.CUSTOMERS[0].id);
      }, { customerId, channelId, scenario });
      await page.locator('#nt-subj').fill('Synthetic workspace'); await page.locator('#nt-cat').selectOption({ index: 1 });
      await page.locator('#nt-pri').selectOption('high');
      if (scenario === 'hidden-message') {
        check(await page.locator('#compose-new-ticket, #nt2-send-btn, [data-action="nt.responses"], #nt2-files').count() === 0, 'Hidden First message omits writing, send and attachment controls');
        await page.locator('#nt2-draft-btn').click();
        await page.locator('.new-ticket-workspace').waitFor({ state: 'detached' });
        check(creates === 1 && messages === 0 && drafts.reply.body === '', 'Hidden First message still permits a metadata-only unsent draft');
        continue;
      }
      if (scenario === 'loading-editor') {
        await page.locator('#nt2-msg').fill('Typed while loading'); releaseEditor();
        await page.locator('#compose-new-ticket .ql-editor').waitFor();
        check(await page.locator('#compose-new-ticket .ql-editor').innerText() === 'Typed while loading', 'Lazy editor loading keeps immediate typing');
        continue;
      }
      const editor = scenario === 'plain-fallback' ? page.locator('textarea#compose-new-ticket') : page.locator('#compose-new-ticket .ql-editor');
      await editor.waitFor();
      if (scenario === 'restricted') {
        check(await page.locator('#nt2-send-btn').isDisabled(), 'Create-only role cannot send');
        check(await editor.getAttribute('contenteditable') === 'false', 'Create-only role cannot write a reply');
        check(await page.locator('#nt2-files').count() === 0, 'Create-only role cannot attach');
      } else if (scenario !== 'empty-draft') {
        await editor.fill('Reference {ticket}');
        if (scenario !== 'plain-fallback') await page.evaluate(async () => {
          (await import('/js/tickets/composer.js')).setHtml('new-ticket', '<p>Reference <strong>{ticket}</strong></p>');
        });
      }
      await page.locator('#nt2-cc').fill('copy@example.test'); await page.locator('#nt2-from').selectOption(channelId);
      if (scenario.startsWith('ai')) {
        if (scenario === 'ai-label') {
          await page.locator('#nt2-without-ai-btn').click();
          await page.locator('#nt2-draft-btn:not(:disabled)').waitFor();
          await page.locator('#nt2-after-send').selectOption('pending');
          await page.locator('#compose-new-ticket .ql-editor').waitFor();
        }
        await page.getByRole('button', { name: 'Improve', exact: true }).click();
        if (['ai-edited','ai-rerender'].includes(scenario)) {
          await page.waitForFunction(() => document.querySelector('#nt-ai-status')?.textContent.includes('Preparing'));
          await editor.focus(); await page.keyboard.press('Control+Shift+Space');
          check(await page.locator('#template-picker-results').count() === 0, 'Template shortcut cannot open the picker during AI generation');
          if (scenario === 'ai-edited') await editor.fill('Agent edits made while waiting');
          else {
            await page.locator('#nt2-files').setInputFiles({ name: 'synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic') });
            check(await page.locator('#nt2-send-btn').isDisabled() && await page.locator('#nt2-draft-btn').isDisabled() && await page.locator('#nt2-without-ai-btn').isDisabled(), 'AI-busy buttons remain disabled after the form redraws');
          }
          while (!releaseAi) await new Promise(resolve => setTimeout(resolve, 10));
          releaseAi();
        }
        await page.waitForFunction(() => !document.querySelector('#nt-ai-status')?.textContent);
        const text = await editor.innerText();
        check(text === (['ai','ai-label'].includes(scenario) ? 'Customer suggestion only.' : scenario === 'ai-edited' ? 'Agent edits made while waiting' : 'Reference {ticket}'), 'AI results preserve edits and failures keep the original');
        check(!text.includes('Private agent note.'), 'Internal AI notes never enter customer text');
        if (scenario === 'ai') check((await page.locator('#nt-ai-notes').innerText()).includes('Private agent note.'), 'Internal notes appear separately');
        check(creates === (scenario === 'ai-label' ? 1 : 0) && messages === 0, 'AI tools never create or send a ticket');
        check(await page.locator('#nt2-send-btn').innerText() === (scenario === 'ai-label' ? 'Send & pending' : 'Send'), 'AI completion restores the current action label');
        if (scenario === 'ai-rerender') check((await page.locator('body').innerText()).includes('The ticket changed while AI was working.'), 'Discarded AI result explains why and how to retry');
        check(errors.length === 0, `No AI browser errors: ${errors.join('; ')}`);
        continue;
      }
      if (scenario === 'scope-change') {
        await page.evaluate(async () => (await import('/js/core/api-client.js')).setWorkspaceId('44444444-4444-4444-8444-444444444444'));
        check(await page.locator('.new-ticket-workspace').count() === 0 && creates === 0, 'Changing workspace clears unsubmitted customer content');
        continue;
      }
      check(creates === 0, 'Typing never creates a ticket');
      await page.locator(scenario === 'send' ? '#nt2-without-ai-btn' : '#nt2-draft-btn').click();
      if (scenario === 'busy-shortcut') {
        await page.locator('.new-ticket-workspace').evaluate(node => { node.tabIndex = -1; node.focus(); });
        await page.keyboard.press('Control+Shift+Space');
        check(await page.locator('#template-picker-results').count() === 0, 'Template shortcut cannot open the picker during saving');
        while (!releaseCreate) await new Promise(resolve => setTimeout(resolve, 10));
        releaseCreate();
      }
      if (scenario === 'create-failed') {
        await page.locator('#nt2-draft-btn:not(:disabled)').waitFor();
        check(await page.locator('#nt-subj').inputValue() === 'Synthetic workspace' && (await editor.innerText()).includes('{ticket}'), 'Create failure keeps details and message');
        continue;
      }
      if (scenario === 'draft-retry') {
        await page.locator('.nt-saved-notice').waitFor(); failDraft = false;
        await page.locator('#nt2-draft-btn').click();
      }
      await page.locator('.new-ticket-workspace').waitFor({ state: 'detached' });
      check(creates === 1, 'Explicit save/send creates exactly one ticket, including retries');
      check(messages === (scenario === 'send' ? 1 : 0), 'Saving a draft never emails');
      if (scenario !== 'send') {
        check(drafts.reply.recipients.cc === 'copy@example.test' && drafts.reply.recipients.sending_address === 'support@example.test', 'Draft retains Cc and sender');
        if (!['empty-draft','restricted'].includes(scenario)) check(drafts.reply.body.includes('TK-WORKSPACE'), 'Draft resolves the minted ticket reference');
        // Reload the application, restore only the synthetic session/list row, then fetch the personal draft.
        await page.reload();
        await page.waitForFunction(() => typeof window.login === 'function');
        await page.evaluate(async ({ row, customerId, scenario }) => {
          window.login('Admin', 'Synthetic workspace tester', 'WT', { userId: 'workspace-' + scenario });
          const api = await import('/js/core/api-client.js'), data = await import('/js/core/data.js');
          api.setJwt('synthetic'); api.setWorkspaceId('33333333-3333-4333-8333-333333333333');
          Object.assign(data.CUSTOMERS[0], { _uuid: customerId, email: 'synthetic@example.test' });
          (await import('/js/core/bootstrap.js')).updateOrInsertTicket(row);
          (await import('/js/core/state.js')).setComposeTabValue('reply');
          (await import('/js/tickets/detail.js')).openTicket(row.display_id);
        }, { row, customerId, scenario });
        await page.waitForFunction(() => document.querySelector('#reply-cc-TK-WORKSPACE')?.value === 'copy@example.test');
        check(await page.locator('#reply-from-TK-WORKSPACE').inputValue() === channelId, 'Reload restores the chosen sending inbox');
        if (scenario === 'rich-draft') check(await page.locator('#compose-TK-WORKSPACE .ql-editor strong').innerText() === 'TK-WORKSPACE', 'Reload restores rich draft formatting');
      }
      check(errors.length === 0, `No browser errors in ${scenario}: ${errors.join('; ')}`);
      console.log('PASS ticket workspace: ' + scenario);
    } catch (error) { console.error({ scenario, errors }); throw error; }
    finally { releaseEditor?.(); releaseAi?.(); releaseCreate?.(); await context.close(); }
  }
  return { checks };
}
