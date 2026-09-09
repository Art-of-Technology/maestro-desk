// Run with scripts/serve-spa.js in an isolated Playwright page. API replies
// are fixtures; no provider requests, customer messages or production writes.
export default async function checkAI(page, screenshotDir) {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const requests = [];
  let fail = false, connected = true, enrichment = false;
  await page.route('**/api/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/v1/workspace/settings', async r => {
    if (r.request().method() === 'PATCH') enrichment = r.request().postDataJSON().ai_player_enrichment;
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ workspace: { ai_player_enrichment: enrichment } }) });
  });
  await page.route('**/api/v1/ai/status', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true, balance_micro: 5000000, player_enrichment: enrichment }) }));
  await page.route('**/api/v1/ai/check', r => r.fulfill({ status: connected ? 200 : 502, contentType: 'application/json', body: JSON.stringify(connected ? { connected: true } : { error: 'Check the provider key and model access.' }) }));
  await page.route('**/api/v1/ai/messages', async r => {
    const body = r.request().postDataJSON();
    requests.push({ body, headers: r.request().headers() });
    const text = body.action === 'summarize' ? JSON.stringify({ tldr: 'Summary fixture', issue: 'Issue', done: 'Done', next: 'Next' })
      : body.action === 'detect_language' ? 'French' : body.action === 'translate' ? 'Hello' : 'AI fixture reply';
    await r.fulfill({ status: fail ? 402 : 200, contentType: 'application/json', body: JSON.stringify(fail ? { error: 'Not enough AI credit.' } : { text }) });
  });
  await page.goto('http://localhost:5173');
  await page.waitForFunction(() => typeof window.login === 'function');
  await page.evaluate(async () => {
    const api = await import('/js/core/api-client.js');
    api.setJwt('ai-browser-fixture');
    api.setWorkspaceId('11111111-1111-4111-8111-111111111111');
    window.login('Admin', 'AI Tester', 'AT', { userId: 'ai-browser-user' });
    (await import('/js/core/router.js')).nav('settings');
    window.setSettingsTab('ai');
  });
  await page.waitForFunction(() => document.querySelector('#ai-settings-status')?.textContent.includes('$5.0000'));
  check(await page.locator('#set-ai-key').count() === 0, 'Browser key field must be removed');
  await page.locator('[data-action="settings.checkAi"]').click();
  await page.waitForFunction(() => document.querySelector('#ai-connection-result')?.textContent.startsWith('Connected'));
  connected = false;
  await page.locator('[data-action="settings.checkAi"]').click();
  await page.waitForFunction(() => document.querySelector('#ai-connection-result')?.textContent.includes('Check the provider'));
  connected = true;
  await page.selectOption('#set-ai-model', 'claude-haiku-4-5');
  check(await page.locator('#ai-connection-result').innerText() === '', 'Changing model must clear stale connection success');
  await page.locator('#ai-player-enrichment').focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#ai-privacy-result')?.textContent.includes('saved'));
  check(enrichment, 'Privacy toggle must save via change delegation');
  const layouts = [];
  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const model = await page.locator('#set-ai-model').boundingBox();
    const button = await page.locator('[data-action="settings.checkAi"]').boundingBox();
    check(model.x >= 0 && model.x + model.width <= width, 'AI model control must fit the viewport');
    check(button.height >= 44, 'Connection check needs a 44px touch target');
    if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/ai-settings-${width}.png` });
    layouts.push({ width, buttonHeight: button.height });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const translations = await page.evaluate(async () => {
    const ai = await import('/js/ai/translate.js');
    return { translated: await ai.translateText('Bonjour', 'English'), detected: await ai.detectLanguage('Bonjour') };
  });
  check(translations.translated.translation === 'Hello' && translations.detected === 'French', 'Translation and detection must use server replies');
  const summary = await page.evaluate(async () => {
    const { TICKETS } = await import('/js/core/data.js');
    await (await import('/js/ai/summarize.js')).summarizeTicket(TICKETS[0].id);
    return TICKETS[0].aiSummary;
  });
  check(summary.tldr === 'Summary fixture', 'Summary must parse the server response');
  await page.evaluate(async () => {
    const { TICKETS } = await import('/js/core/data.js');
    await (await import('/js/tickets/detail.js')).openTicket(TICKETS[0].id);
  });
  await page.locator('[id^="compose-"] .ql-editor').waitFor();
  await page.evaluate(async () => {
    const { TICKETS } = await import('/js/core/data.js');
    await (await import('/js/ai/reply.js')).aiAction(TICKETS[0].id, 'draft');
  });
  check((await page.locator('[id^="compose-"] .ql-editor').innerText()).trim() === 'AI fixture reply', 'Draft must fill the composer');
  fail = true;
  const dialogs = [];
  const onDialog = async d => { dialogs.push(d.message()); await d.accept(); };
  page.on('dialog', onDialog);
  await page.evaluate(async () => {
    const { TICKETS } = await import('/js/core/data.js');
    await (await import('/js/ai/reply.js')).aiAction(TICKETS[0].id, 'improve');
  });
  check(dialogs.includes('Not enough AI credit.'), 'Composer must surface credit errors');
  check((await page.locator('[id^="compose-"] .ql-editor').innerText()).trim() === 'AI fixture reply', 'Failure must preserve the draft');
  page.off('dialog', onDialog);
  fail = false;
  await page.evaluate(async () => (await import('/js/core/router.js')).nav('ai'));
  await page.fill('#ai-input', 'Summarise these tickets');
  await page.locator('[data-action="ai.send"]').click();
  await page.waitForFunction(async () => (await import('/js/core/state.js')).AI_MESSAGES.some(m => m.t === 'AI fixture reply'));
  check(requests.at(-1).body.action === 'chat' && requests.at(-1).body.sources.includes('tickets'), 'Chat must send source selectors');
  check(!requests.at(-1).body.system, 'Chat context must not come from browser data');
  await page.evaluate(async () => {
    (await import('/js/core/api-client.js')).setWorkspaceId('22222222-2222-4222-8222-222222222222');
    (await import('/js/core/router.js')).renderPage('ai');
  });
  check(await page.evaluate(async () => (await import('/js/core/state.js')).AI_MESSAGES.length) === 0, 'Workspace switch must clear active chat');
  await page.evaluate(async () => {
    (await import('/js/core/api-client.js')).setWorkspaceId('11111111-1111-4111-8111-111111111111');
    (await import('/js/core/state.js')).setSession({ role: 'Agent', name: 'Other user', userId: 'different-user' });
    (await import('/js/core/router.js')).renderPage('ai');
  });
  check(await page.evaluate(async () => (await import('/js/core/state.js')).AI_MESSAGES.length) === 0, 'Different user must not load another user’s chat');
  await page.evaluate(async () => { (await import('/js/core/router.js')).nav('settings'); window.setSettingsTab('ai'); });
  await page.waitForFunction(() => document.querySelector('#ai-settings-status')?.textContent.includes('$5.0000'));
  check(await page.locator('#ai-player-enrichment').isDisabled(), 'Non-admin cannot change privacy');
  check(requests.every(r => r.headers.authorization === 'Bearer ai-browser-fixture' && r.headers['x-workspace-id'] === '11111111-1111-4111-8111-111111111111' && !r.headers['x-api-key']), 'Requests must use workspace auth, never a provider key');
  return { layouts, actions: [...new Set(requests.map(r => r.body.action))], checks: 'settings, privacy, drafts, errors, summaries, translations, chat and account isolation passed' };
}
