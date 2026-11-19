// Run against scripts/serve-spa.js with a Playwright page.
export default async function checkFooterOnlyEmail(page) {
  await page.route('http://localhost:5173/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Footer-only email check</title>' }));
  await page.goto('http://localhost:5173/');
  return page.evaluate(async () => {
    const { renderEmptyEmailNotice, renderMessageBody } = await import('/js/tickets/message-html.js');
    const footer = 'To unsubscribe from this group and stop receiving emails from it, send an email to group+unsubscribe@example.test.';
    const html = '<div dir="auto"></div>\r\n<p></p>\r\n' + footer.replace('group+unsubscribe@example.test', '<a href="mailto:group+unsubscribe@example.test">group+unsubscribe@example.test</a>') + '<br />';
    const message = { r: 'customer', email: { status: 'received' }, t: '\r\n' + footer + '\r\n', html, attachments: [] };
    const original = JSON.stringify(message);
    let checks = 0;
    const check = (ok, label) => { checks++; if (!ok) throw Error(label); };
    check(renderEmptyEmailNotice(message).includes('No message text.'), 'Existing HTML email lacks notice');
    check(!!renderEmptyEmailNotice({ ...message, html: null }), 'Plain-text footer lacks notice');
    check(!!renderEmptyEmailNotice({ ...message, html: html.replace('To unsubscribe', 'To&nbsp;unsubscribe') }), 'HTML whitespace not normalised');
    for (const patch of [
      { t: 'Hello\n' + footer }, { html: '<p>Hello</p>' + html },
      { t: '' }, { t: '(empty body)', html: null },
      { html: html + '<img src="cid:image">' }, { html: html + '<hr>' },
      { html: html + '<div style="background-image:url(https://example.test/image)"></div>' },
      { html: html + '<a href="https://example.test/file"></a>' },
      { attachments: [{ id: 'file' }] }, { r: 'agent' }, { r: 'note' },
      { email: null }, { email: { status: 'sent' } },
    ]) check(renderEmptyEmailNotice({ ...message, ...patch }) === '', `False empty notice: ${JSON.stringify(patch)}`);
    window.escAttr = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const root = document.createElement('div');
    root.innerHTML = renderEmptyEmailNotice(message) + renderMessageBody(message, 'fixture', 0, footer);
    document.body.replaceChildren(root);
    check(root.querySelector('iframe').srcdoc.includes(html.replaceAll('\r\n', '\n')), 'Original HTML was changed');
    check(JSON.stringify(message) === original, 'Stored message was mutated');
    check(root.textContent.includes('No message text.'), 'Notice missing from rendered thread');
    return { checks };
  });
}
