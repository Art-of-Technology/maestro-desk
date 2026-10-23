// Local synthetic API only; no files or messages reach a real service.
export default async (browser, screenshotsDir) => {
  let checks = 0;
  const check = (condition, message) => { checks++; if (!condition) throw Error(message); };
  for (const scenario of ['send', 'manual', 'draft', 'retry', 'cancel', 'cancel-created', 'large', 'restricted', 'switched']) {
    const context = await browser.newContext({ viewport: { width: scenario === 'retry' ? 390 : 1280, height: 900 } });
    const page = await context.newPage();
    try {
      const workspace = '33333333-3333-4333-8333-333333333333', ticketId = '11111111-1111-4111-8111-111111111111', customerId = '22222222-2222-4222-8222-222222222222';
      const row = { id: ticketId, display_id: 'TK-FILES', customer_id: customerId, subject: 'Synthetic files', status_key: 'open', status_option_key: 'open', priority_key: 'normal' };
      let creates = 0, allowRetry = false, version = 0, draft = { body: '', attachments: [], version: 0 }, uploads = [], messages = [], files = [];
      page.on('dialog', dialog => dialog.accept());
      await page.route('**/api/**', async route => {
        const req = route.request(), path = new URL(req.url()).pathname;
        const body = req.headers()['content-type']?.includes('application/json') ? req.postDataJSON() : null;
        let json = {}, status = 200;
        if (path.endsWith('/ticket-statuses')) json = { statuses: ['open','pending','resolved','escalated','gdpr','closed'].map(key => ({ key, label: key, base_key: key, is_active: true, reasons: [], send_survey: false })) };
        else if (path.endsWith('/customers/' + customerId) && req.method() === 'PATCH') json = { customer: { preferred_language: body.preferred_language } };
        else if (path.endsWith('/ai/messages')) json = { text: body.action === 'detect_language' ? 'English' : 'Synthetic message' };
        else if (path.endsWith('/tickets') && req.method() === 'POST') { creates++; json = { ticket: row }; }
        else if (path.endsWith('/attachments') && req.method() === 'POST') {
          const filename = /filename="([^"]+)"/.exec(req.postDataBuffer().toString())?.[1]; uploads.push(filename);
          if (scenario === 'switched') await page.evaluate(async () => (await import('/js/core/api-client.js')).setWorkspaceId('44444444-4444-4444-8444-444444444444'));
          if (['retry','cancel-created'].includes(scenario) && filename === 'second.txt' && !allowRetry) { status = 503; json = { error: 'Synthetic upload unavailable' }; }
          else { const attachment = { id: crypto.randomUUID(), filename, size_bytes: 9 }; files.push(attachment); json = { attachment }; }
        } else if (path.endsWith('/drafts/reply')) {
          if (req.method() === 'PUT') draft = { ...body, version: ++version, attachments: files.filter(file => body.attachment_ids.includes(file.id)) };
          json = { draft };
        } else if (path.endsWith('/messages') && req.method() === 'POST') {
          messages.push(body); draft = { body: '', is_html: false, recipients: null, review: null, attachments: [], version: ++version };
          json = { message: { id: crypto.randomUUID(), role: 'agent', body: body.body, created_at: new Date().toISOString(), attachments: files }, draft_version: version, delivery: { emailed: true } };
        } else if (path.endsWith('/tickets/' + ticketId)) json = { ticket: { ...row, messages: [], activity: [], reply_recipients: { to: ['synthetic@example.test'], cc: [], sending_inboxes: [], source_message_id: null } } };
        await route.fulfill({ status, json });
      });
      await page.goto('http://localhost:5173');
      await page.waitForFunction(() => typeof window.login === 'function');
      await page.evaluate(async ({ workspace, customerId, scenario }) => {
        window.login('Admin', 'Synthetic tester', 'ST', { userId: 'files-' + scenario });
        const api = await import('/js/core/api-client.js'); api.setJwt('synthetic'); api.setWorkspaceId(workspace);
        const data = await import('/js/core/data.js'); data.CUSTOMERS[0]._uuid = customerId; data.CUSTOMERS[0].preferredLanguage = 'English';
        if (scenario === 'restricted') {
          const state = await import('/js/core/state.js'); state.setSession({ ...state.SESSION, permissions: { 'tickets.create': true, 'tickets.reply': true } });
        }
        if (!data.CATEGORIES.length) data.CATEGORIES.push({ key: 'general', label: 'General', is_active: true });
        await (await import('/js/tickets/new-ticket.js')).showNewTicketModal(null, data.CUSTOMERS[0].id);
      }, { workspace, customerId, scenario });
      await page.locator('#nt-subj').fill('Synthetic files'); await page.locator('#nt-cat').selectOption({ index: 1 });
      await page.locator('[data-action="modal.confirm"]').click();
      await page.getByRole('button', { name: 'Confirm and continue', exact: true }).click();
      if (scenario === 'restricted') { check(await page.locator('#nt2-files').count() === 0, 'Attachment permission hides file input'); continue; }
      await page.locator('#nt2-msg').fill('Synthetic message');
      const selected = scenario === 'large' ? [{ name: 'large.txt', mimeType: 'text/plain', buffer: Buffer.alloc(8 * 1024 * 1024, 65) }]
        : ['receipt <tag>.txt','second.txt'].map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from('synthetic') }));
      await page.locator('#nt2-files').setInputFiles(selected);
      if (screenshotsDir && ['send','retry'].includes(scenario)) await page.screenshot({ path: `${screenshotsDir}/new-ticket-files-${scenario}.png`, fullPage: true });
      check(creates === 0 && uploads.length === 0, 'Selecting files performs no writes');
      check(await page.locator('#nt2-msg').inputValue() === 'Synthetic message', 'File selection preserves message');
      check(await page.getByRole('button', { name: 'Remove receipt <tag>.txt', exact: true }).count() === (scenario === 'large' ? 0 : 1), 'File names are rendered safely');
      if (scenario === 'cancel') {
        await page.getByRole('button', { name: 'Cancel new ticket', exact: true }).click();
        check(creates === 0 && uploads.length === 0 && messages.length === 0, 'Cancel before creation performs no writes'); continue;
      }
      if (scenario === 'large') {
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        check(creates === 0, 'Oversized outgoing email is rejected before creating a ticket');
      }
      if (scenario === 'manual') await page.locator('[data-action="nt.sendWithoutAI"]').click();
      else await page.getByRole('button', { name: ['draft','large'].includes(scenario) ? 'Save as draft' : 'Send', exact: true }).click();
      if (['retry','cancel-created'].includes(scenario)) {
        await page.getByRole('status').filter({ hasText: 'already created' }).waitFor();
        check(creates === 1 && uploads.length === 2 && messages.length === 0, 'Failed second upload cannot send a partial message');
        check(draft.attachments.length === 1, 'Successful upload is saved in the private draft');
        check(await page.locator('#nt2-msg').inputValue() === 'Synthetic message', 'Failed upload preserves message for retry');
        const target = await page.getByRole('button', { name: 'Remove second.txt', exact: true }).boundingBox();
        check(target.width >= 44 && target.height >= 44, 'Remove control has a 44px target');
        check(await page.locator('.modal').evaluate(el => el.scrollWidth <= el.clientWidth), 'Mobile modal has no horizontal overflow');
        if (scenario === 'cancel-created') {
          await page.getByRole('button', { name: 'Cancel new ticket', exact: true }).click();
          check(creates === 1 && messages.length === 0, 'Cancelling partial upload opens existing draft without sending'); continue;
        }
        allowRetry = true;
        await page.getByRole('button', { name: 'Send', exact: true }).click();
      }
      await page.locator('#nt2-msg').waitFor({ state: 'detached' });
      check(creates === 1, 'Final actions create only one ticket');
      if (scenario === 'switched') { check(messages.length === 0, 'Workspace change prevents sending'); continue; }
      if (['draft','large'].includes(scenario)) check(messages.length === 0 && draft.attachments.length === selected.length, 'Save as draft syncs private files without sending');
      else {
        check(messages.length === 1 && messages[0].attachment_ids.length === 2, 'One message includes every selected attachment');
        check(Number.isInteger(messages[0].draft_version), 'Sending consumes the versioned private draft');
        if (scenario === 'retry') check(uploads.length === 3 && uploads.filter(name => name === 'receipt <tag>.txt').length === 1, 'Retry skips the already-uploaded file');
      }
      console.log('PASS new-ticket files: ' + scenario);
    } finally { await context.close(); }
  }
  return { checks };
};
