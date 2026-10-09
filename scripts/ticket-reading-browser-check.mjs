// Local demo fixture. Call with a Playwright page served by scripts/serve-spa.js.
export default async function checkTicketReading(page) {
  if (!page.url().startsWith('http://localhost:5173/')) throw Error('Local fixture only');
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.evaluate(async () => {
    window.login('Admin', 'Reading tester', 'RT');
    (await import('/js/guides/index.js')).closeGuides(false);
  });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(async () => {
      const { TICKETS } = await import('/js/core/data.js');
      const { openTicket } = await import('/js/tickets/detail.js');
      const { renderPage } = await import('/js/core/router.js');
      const ticket = TICKETS[0], original = ticket.msgs;
      const check = (ok, label) => { if (!ok) throw Error(label); };
      const until = async predicate => {
        for (let i = 0; i < 150; i++) {
          if (predicate()) return;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        throw Error('Timed out waiting for ticket reading position');
      };
      const thread = () => document.getElementById('thread-' + ticket.id);
      const latestAtStart = () => Math.abs(thread().lastElementChild.getBoundingClientRect().top - thread().getBoundingClientRect().top) < 2;
      const paragraphs = Array.from({ length: 80 }, (_, i) => `<p>Long email paragraph ${i}</p>`).join('');
      const email = { r: 'customer', from: 'Customer', t: 'Long email', html: paragraphs };
      const note = { r: 'note', from: 'Agent', t: Array.from({ length: 80 }, (_, i) => `Internal note line ${i}`).join('\n') };
      const freshOpen = () => { renderPage('tickets'); openTicket(ticket.id); };
      try {
        for (const latest of [email, note, { ...email, html: undefined, t: note.t }]) {
          ticket.msgs = [email, latest];
          freshOpen();
          // Repaint immediately, before the newly inserted iframe has loaded.
          openTicket(ticket.id);
          await until(() => thread().querySelector('.msg-frame')?.clientHeight > 1200 && latestAtStart());
          await new Promise(resolve => setTimeout(resolve, 100));
          check(latestAtStart(), 'Latest email/note start was lost after loading');
          thread().scrollTop += 250;
          const offset = thread().lastElementChild.getBoundingClientRect().top - thread().getBoundingClientRect().top;
          openTicket(ticket.id);
          await until(() => thread().querySelector('.msg-frame')?.clientHeight > 1200 &&
            Math.abs(thread().lastElementChild.getBoundingClientRect().top - thread().getBoundingClientRect().top - offset) < 2);
          openTicket(TICKETS[1].id);
          openTicket(ticket.id);
          await until(latestAtStart);
        }
        ticket.msgs = [email, { ...note, t: 'Short latest note' }];
        freshOpen();
        await until(() => thread().querySelector('.msg-frame')?.clientHeight > 1200);
        check(thread().lastElementChild.getBoundingClientRect().bottom <= thread().getBoundingClientRect().bottom, 'Short note is outside the viewport');
        ticket.msgs = [note];
        freshOpen();
        await until(latestAtStart);
        ticket.msgs = [];
        freshOpen();
        check(thread().scrollTop === 0, 'Empty ticket did not open at the top');
        check(document.documentElement.scrollWidth <= window.innerWidth, 'Ticket overflows horizontally');
      } finally { ticket.msgs = original; renderPage('tickets'); }
    });
  }
  return { passed: true, checks: ['desktop/mobile', 'long HTML email', 'plain email', 'internal note', 'refresh before frames load', 'reading position on refresh', 'ticket switching', 'short note', 'single note', 'empty ticket'] };
}
