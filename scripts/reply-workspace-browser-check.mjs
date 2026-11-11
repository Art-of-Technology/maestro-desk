// Local synthetic ticket only; API requests are intercepted, including sends.
export default async function checkReplyWorkspace(page) {
  if (!page.url().startsWith('http://localhost:5173/')) throw Error('Local fixture only');
  let checks = 0;
  const check = (ok, message) => { if (!ok) throw Error(message); checks++; };
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await page.evaluate(async () => {
    window.login('Admin', 'Layout tester', 'LT');
    const { TICKETS } = await import('/js/core/data.js');
    const t = TICKETS[0];
    (await import('/js/tickets/drafts.js')).clearAllDrafts(t.id);
    Object.assign(t, { _uuid: '00000000-0000-4000-8000-000000000001', _detailLoaded: true,
      subject: 'Payment query', autoTranslateReplies: false,
      replyRecipients: { source_message_id: 'fixture-message', to: ['customer@example.test'], cc: [],
        default_from: 'support@example.test', sending_inboxes: [] } });
    (await import('/js/tickets/detail.js')).openTicket(t.id);
  });
  await page.locator('[data-compose-launch][data-tab="reply"]').click();
  await page.locator('.ql-editor').fill('Keep this reply while resizing.');
  check(await page.locator('.composer-tool').count() === 7, 'Shortcut icons were grouped or removed');
  const original = await page.locator('.ql-editor').boundingBox();
  check(original.height > 220, 'Default email editor is still cramped');
  const separator = page.getByRole('separator', { name: 'Resize reply area' });
  await separator.focus();
  await page.keyboard.press('ArrowUp');
  check(await separator.getAttribute('aria-valuenow') === '75', 'Keyboard resize failed');
  const handle = await separator.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 55, { steps: 5 });
  await page.mouse.up();
  const resized = await separator.getAttribute('aria-valuenow');
  check(Number(resized) < 75, 'Pointer resize failed');
  await page.locator('[data-action="tl.expand"]').click();
  check((await page.locator('.ql-editor').boundingBox()).height > original.height, 'Expand did not enlarge the editor');
  await page.locator('[data-action="tl.expand"]').click();
  check(await separator.getAttribute('aria-valuenow') === resized, 'Restore lost the chosen reply size');
  check(await page.locator('.ql-editor').innerText() === 'Keep this reply while resizing.', 'Resizing lost the draft');
  await page.locator('[data-action="td.toggleReplyCc"]').click();
  await page.locator('[data-input-action="td.replyCc"]').fill('reviewer@example.test');
  await page.locator('.composer-tabs [data-tab="note"]').click();
  check(await page.locator('.reply-recipients').count() === 0, 'Note exposes email recipients');
  await page.locator('textarea.compose-area').fill('Private note');
  await page.locator('.composer-tabs [data-tab="reply"]').click();
  check(await page.locator('.ql-editor').innerText() === 'Keep this reply while resizing.', 'Note switch lost the reply');
  check(await page.locator('[data-input-action="td.replyCc"]').inputValue() === 'reviewer@example.test', 'Note switch lost CC');
  check(await separator.getAttribute('aria-valuenow') === resized, 'Rerender lost reply size');
  await page.evaluate(async () => {
    const { TICKETS } = await import('/js/core/data.js');
    TICKETS[0].subject = 'A long ticket subject that must not push navigation or the reply controls outside the available workspace '.repeat(4);
    (await import('/js/tickets/detail.js')).openTicket(TICKETS[0].id);
  });
  for (const [width, height] of [[1440, 1000], [1280, 900], [768, 900], [390, 844], [320, 568], [390, 360]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(150);
    const layout = await page.evaluate(() => {
      const send = document.querySelector('[data-action="td.send"]').getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth, sendVisible: send.top >= 0 && send.bottom <= innerHeight + 1 };
    });
    check(!layout.overflow, `Horizontal overflow at ${width}×${height}`);
    check(layout.sendVisible, `Send clipped at ${width}×${height}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  return { checks, passed: true };
}
