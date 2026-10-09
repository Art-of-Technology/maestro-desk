export default async function checkEmailDownloads(page) {
  const check = (ok, message) => { if (!ok) throw Error(message); };
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.goto('http://localhost:5173');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.evaluate(() => window.login('Admin', 'Download tester', 'DT'));
  await page.evaluate(async () => {
    const { TICKETS } = await import('/js/core/data.js');
    const ticket = TICKETS[0];
    ticket._uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    ticket._detailLoaded = true;
    ticket.msgs = [
      { _uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', r: 'customer', from: 'Customer', t: 'Saved email', downloadableEmail: true },
      { _uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', r: 'note', from: 'Agent', t: 'Internal note' },
    ];
    sessionStorage.setItem('maestro_jwt', 'fixture-session');
    sessionStorage.setItem('maestro_workspace_id', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    await (await import('/js/tickets/detail.js')).openTicket(ticket.id);
  });
  let requests = [], fail = false, release;
  await page.route('**/emails/download?*', async route => {
    requests.push(route.request().url());
    if (release) await new Promise(resolve => { release.resolve = resolve; });
    await route.fulfill(fail ? { status: 503, json: { error: 'Attachment unavailable. Try PDF.' } }
      : { status: 200, contentType: 'application/octet-stream', body: 'fixture-download' });
  });
  const emailButton = page.getByRole('button', { name: 'Download email', exact: true });
  check(await emailButton.count() === 1, 'Only customer-facing email has a download button');
  await emailButton.click();
  check(await page.locator('#email-download-format option').count() === 2, 'Formats are offered on every download');
  await page.locator('#email-download-format').selectOption('eml');
  const singleEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  check((await singleEvent).suggestedFilename().endsWith('.eml'), 'Individual download is an EML');
  check(requests.at(-1).includes('messageId=bbbbbbbb-'), 'Selected persisted message ID reaches API');
  await page.locator('.ticket-more summary').click();
  await page.getByRole('button', { name: 'Download thread', exact: true }).click();
  check(await page.locator('#email-download-format').inputValue() === 'pdf', 'Fresh prompt defaults to PDF');
  check((await page.locator('#modal-container').innerText()).includes('Internal notes, drafts and status changes are excluded'), 'Thread scope is explained');
  const threadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  check((await threadEvent).suggestedFilename().endsWith('-thread.pdf'), 'Thread PDF download');
  check(!requests.at(-1).includes('messageId'), 'Full thread requests all emails');
  await page.locator('.ticket-more summary').click();
  await page.getByRole('button', { name: 'Download thread', exact: true }).click();
  await page.locator('#email-download-format').selectOption('eml');
  const zipEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  check((await zipEvent).suggestedFilename().endsWith('-thread.zip'), 'Thread email download is ZIP');
  await page.setViewportSize({ width: 390, height: 844 });
  await emailButton.click();
  fail = true;
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('email-download-error')?.textContent.includes('Attachment unavailable'));
  check(await page.getByRole('button', { name: 'Download', exact: true }).isEnabled(), 'Failure allows retry');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile dialog does not overflow');
  fail = false;
  release = {};
  let staleDownloads = 0;
  page.on('download', () => staleDownloads++);
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-action="modal.confirm"]')?.disabled);
  while (!release.resolve) await new Promise(resolve => setTimeout(resolve, 10));
  await page.evaluate(() => sessionStorage.setItem('maestro_workspace_id', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'));
  release.resolve();
  await page.waitForTimeout(300);
  check(staleDownloads === 0, 'Workspace change discards stale private download');
  return { checks: 'single EML, thread PDF and ZIP, fresh format prompts, internal-note exclusion, retry, mobile, stale workspace response' };
}
