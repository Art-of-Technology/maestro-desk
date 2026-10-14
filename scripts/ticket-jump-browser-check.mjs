// Local fixtures only. Run with a Playwright page served by scripts/serve-spa.js.
export default async function checkTicketJump(page) {
  if (!page.url().startsWith('http://localhost:5173/')) throw Error('Local fixture only');
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  const original = await page.evaluate(async () => {
    window.login('Admin', 'Jump tester', 'JT');
    (await import('/js/guides/index.js')).closeGuides(false);
    return (await import('/js/core/data.js')).TICKETS[0].msgs;
  });
  const jump = page.getByRole('button', { name: 'Jump to latest', exact: true });
  const atLatest = () => page.waitForFunction(() => {
    const root = document.querySelector('.thread');
    return Math.abs(root.lastElementChild.getBoundingClientRect().top - root.getBoundingClientRect().top) < 2;
  });
  const setMessages = async kind => page.evaluate(async kind => {
    const { TICKETS } = await import('/js/core/data.js');
    const lines = Array.from({ length: 100 }, (_, i) => `Message line ${i}`);
    const email = { r: 'customer', from: 'Customer', t: lines.join('\n'), html: lines.map(line => `<p>${line}</p>`).join('') };
    const latest = kind === 'html' ? email : { r: kind === 'note' ? 'note' : 'agent', from: 'Agent', t: lines.join('\n') };
    TICKETS[0].msgs = kind === 'empty' ? [] : kind === 'single' ? [latest] : [email, latest];
    (await import('/js/core/router.js')).renderPage('tickets');
    (await import('/js/tickets/detail.js')).openTicket(TICKETS[0].id);
  }, kind);
  try {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const kind of ['html', 'note', 'plain', 'single']) {
        await setMessages(kind);
        await page.waitForFunction(() => [...document.querySelectorAll('.msg-frame')].every(frame => frame.clientHeight > 1200));
        await atLatest();
        await page.evaluate(() => {
          const root = document.querySelector('.thread');
          root.scrollTop = root.children.length === 1 ? 500 : 0;
          window.jumpOriginalThread = root;
        });
        await jump.click();
        await atLatest();
        if (!await page.evaluate(() => window.jumpOriginalThread === document.querySelector('.thread'))) throw Error('Jump rebuilt the ticket');
        if ((await jump.boundingBox()).height < 44) throw Error('Jump touch target is too small');
        if (!await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)) throw Error('Ticket overflows horizontally');
      }
      await setMessages('html');
      await page.waitForFunction(() => [...document.querySelectorAll('.msg-frame')].every(frame => frame.clientHeight > 1200));
      await atLatest();
      // Restore an older message, then jump before its replacement frames load.
      await page.evaluate(async () => {
        const { TICKETS } = await import('/js/core/data.js');
        const root = document.querySelector('.thread');
        root.dispatchEvent(new WheelEvent('wheel'));
        root.scrollTop = 300;
        (await import('/js/tickets/detail.js')).openTicket(TICKETS[0].id);
        document.querySelector('[data-action="td.jumpToLatest"]').click();
        (await import('/js/tickets/detail.js')).openTicket(TICKETS[0].id);
      });
      await page.waitForFunction(() => [...document.querySelectorAll('.msg-frame')].every(frame => frame.clientHeight > 1200));
      await atLatest();
      for (const key of ['Enter', 'Space']) {
        await page.evaluate(() => { document.querySelector('.thread').scrollTop = 0; });
        await jump.focus();
        await page.keyboard.press(key);
        await atLatest();
        if (!await jump.evaluate(el => el === document.activeElement && getComputedStyle(el).outlineStyle !== 'none')) throw Error('Keyboard focus lost or invisible');
      }
      await page.locator('[data-compose-launch][data-tab="reply"]').click();
      await page.locator('.ql-editor').fill('Keep my unsent reply');
      await page.locator('.composer-tabs [data-tab="note"]').click();
      await page.locator('textarea.compose-area').fill('Keep my private note');
      await page.evaluate(() => { window.jumpOriginalEditor = document.querySelector('textarea.compose-area'); document.querySelector('.thread').scrollTop = 0; });
      await jump.click();
      await atLatest();
      if (!await page.evaluate(() => window.jumpOriginalEditor === document.querySelector('textarea.compose-area'))) throw Error('Jump replaced the editor');
      if (await page.locator('textarea.compose-area').inputValue() !== 'Keep my private note') throw Error('Jump lost the note draft');
      await page.locator('.composer-tabs [data-tab="reply"]').click();
      if (!(await page.locator('.ql-editor').innerText()).includes('Keep my unsent reply')) throw Error('Jump lost the reply draft');
      await setMessages('empty');
      if (await jump.count()) throw Error('Empty ticket offers a jump without a destination');
    }
    return { passed: true, checks: ['desktop/mobile', 'HTML/plain/note/single message', 'click', 'Enter/Space and visible focus', '44px target', 'jump during frame loading and refresh', 'reply/note drafts and DOM preserved', 'empty ticket'] };
  } finally {
    await page.evaluate(async original => {
      const { TICKETS } = await import('/js/core/data.js');
      TICKETS[0].msgs = original;
      (await import('/js/tickets/drafts.js')).clearAllDrafts(TICKETS[0].id);
      (await import('/js/core/router.js')).renderPage('tickets');
      delete window.jumpOriginalThread;
      delete window.jumpOriginalEditor;
    }, original);
  }
}
