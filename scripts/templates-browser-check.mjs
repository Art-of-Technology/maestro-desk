// Run against the local static server via Playwright. All API traffic is mocked.
export default async function checkTemplates(page) {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  await page.route('**/api/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.goto('http://localhost:5173');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.evaluate(async () => {
    window.login('Admin', 'Template tester', 'TT');
    const data = await import('/js/core/data.js');
    data.CANNED_RESPONSES.length = 0;
    sessionStorage.setItem('maestro_jwt', 'fixture-only');
    sessionStorage.setItem('maestro_workspace_id', 'fixture-workspace');
    (await import('/js/core/router.js')).nav('templates');
  });
  let writes = 0;
  let saved;
  await page.route('**/api/v1/canned-responses**', async route => {
    const request = route.request();
    if (request.method() === 'POST' || request.method() === 'PATCH') {
      writes++;
      saved = { id: 'fixture-template', display_id: 'TPL-TEST', ...request.postDataJSON() };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ canned_response: saved }) });
    } else await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.getByRole('button', { name: '+ New Template', exact: true }).click();
  await page.waitForSelector('#compose-template-editor .ql-editor');
  await page.locator('#tpl-name').fill('Rich welcome');
  await page.evaluate(() => {
    const q = window.Quill.find(document.getElementById('compose-template-editor'));
    q.clipboard.dangerouslyPasteHTML('<p><strong>Hello {name}, {name}</strong></p><ul><li>{ticket} {brand} {agent}</li></ul><p><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDY4AAAAASUVORK5CYII="></p>');
  });
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForSelector('#modal-container .modal', { state: 'detached' });
  assert(writes === 1, 'First template must be persisted to API in an empty workspace');
  assert(saved.body_html.includes('<strong>') && saved.body_html.includes('data:image/png'), 'Formatting and image must be sent');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.waitForSelector('#compose-template-editor .ql-editor strong');
  assert(await page.locator('#compose-template-editor .ql-editor img').count() === 1, 'Image must survive reopen');
  await page.getByRole('button', { name: '{agent}', exact: true }).click();
  assert((await page.locator('#compose-template-editor .ql-editor').innerText()).includes('{agent}'), 'Variable button inserts text');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const result = await page.evaluate(async () => {
    const data = await import('/js/core/data.js');
    const composer = await import('/js/tickets/composer.js');
    const { appendTemplate } = await import('/js/tickets/template-content.js');
    const detail = await import('/js/tickets/detail.js');
    const ticket = data.TICKETS[0];
    const customer = data.CUSTOMERS.find(c => c.id === ticket.customerId);
    customer.first = '<img src=x onerror=alert(1)> $& {ticket}';
    detail.openTicket(ticket.id);
    await composer.mountComposer(ticket.id);
    composer.setText(ticket.id, 'Existing draft');
    await appendTemplate(ticket, data.CANNED_RESPONSES[0]);
    const html = composer.getHtml(ticket.id);
    const plain = composer.getPlainText(ticket.id);
    const host = document.getElementById('compose-' + ticket.id);
    const imageCount = host.querySelectorAll('img').length;
    return { html, plain, imageCount };
  });
  assert(result.plain.startsWith('Existing draft'), 'Insertion must preserve existing draft');
  assert(result.html.includes('<strong>'), 'Inserted response must keep formatting');
  assert(result.imageCount === 1, 'Customer variable must not inject an image');
  assert(result.plain.includes('$& {ticket}'), 'Variable values must not be re-expanded');
  assert(!result.plain.includes('{brand}') && !result.plain.includes('{agent}'), 'All variable types must resolve');
  const macro = await page.evaluate(async () => {
    const data = await import('/js/core/data.js');
    const macros = await import('/js/tickets/macros.js');
    const composer = await import('/js/tickets/composer.js');
    macros.MACROS.push({ id: 'MAC-TEST', name: 'Rich test', actions: [{ kind: 'reply', templateId: data.CANNED_RESPONSES[0].id }] });
    composer.setText(data.TICKETS[0].id, 'Macro draft');
    macros.showApplyMacroModal(data.TICKETS[0].id);
    return { id: data.TICKETS[0].id };
  });
  await page.locator('[data-macro-id="MAC-TEST"]').dispatchEvent('mousedown');
  await page.waitForFunction(id => document.getElementById('compose-' + id)?.querySelector('strong'), macro.id);
  const macroText = await page.locator('[id="compose-' + macro.id + '"] .ql-editor').innerText();
  assert(macroText.startsWith('Macro draft'), 'Macro must preserve and append to the draft');

  // A failed lazy editor download must leave a usable plain-text form.
  await page.route('**/js/vendor/quill.js', route => route.abort());
  await page.evaluate(() => sessionStorage.clear());
  await page.goto('http://localhost:5173');
  await page.evaluate(async () => {
    window.login('Admin', 'Template tester', 'TT');
    const data = await import('/js/core/data.js');
    data.CANNED_RESPONSES.splice(0, data.CANNED_RESPONSES.length, { id: 'TPL-OLD', name: 'Old template', text: 'Hello {name}', category: 'General' });
    (await import('/js/core/router.js')).nav('templates');
  });
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.waitForSelector('textarea#compose-template-editor');
  assert(await page.locator('#compose-template-editor').inputValue() === 'Hello {name}', 'Legacy plain body must survive editor failure');
  await page.locator('#compose-template-editor').fill('Fallback edit');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForSelector('#modal-container .modal', { state: 'detached' });
  assert(await page.evaluate(async () => (await import('/js/core/data.js')).CANNED_RESPONSES[0].text) === 'Fallback edit', 'Fallback must save');
  await page.unroute('**/js/vendor/quill.js');
  return { writes, checks: 'empty workspace persistence, edit round-trip, inline image, variable button, rich insertion, draft preservation, injection protection, macro insertion, legacy plain fallback' };
}
