// Run with the Playwright tool against `bun scripts/serve-spa.js`.
// Load this file with browser_run_code_unsafe's filename argument.
async function checkEmailLogo(page) {
  const origin = 'https://email-logo.test';
  const logo = `${origin}/logo.svg`;
  const requests = [];
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="88" height="36"><rect width="88" height="36" fill="purple"/></svg>';
  const config = await (await page.request.get('http://localhost:5173/vercel.json')).json();
  const csp = config.headers.flatMap(h => h.headers).find(h => h.key.toLowerCase() === 'content-security-policy').value;
  await page.route(`${origin}/**`, async route => {
    requests.push(route.request().url());
    if (route.request().url().endsWith('/unavailable.svg')) return route.abort();
    if (route.request().url().endsWith('/slow.svg')) await new Promise(resolve => setTimeout(resolve, 300));
    await route.fulfill({ contentType: 'image/svg+xml', body: svg,
      headers: { 'access-control-allow-origin': '*' } });
  });
  await page.route('http://localhost:5173/', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Email logo check</title>',
    headers: { 'content-security-policy': csp },
  }));
  try {
    await page.goto('http://localhost:5173/');
    await page.evaluate(async ({ logo, origin }) => {
      const { setEmailLogo, renderMessageBody, sizeMessageFrames, enableRemoteImages } = await import('/js/tickets/message-html.js');
      window.escAttr = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      const check = (ok, message) => { if (!ok) throw Error(message); };
      const until = async predicate => {
        for (let i = 0; i < 150; i++) {
          if (predicate()) return;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        throw Error('Timed out waiting for image state');
      };
      const root = document.createElement('div');
      document.body.append(root);
      let index = 0;
      const render = async (html, attachments = []) => {
        root.innerHTML = renderMessageBody({ html, attachments }, 'logo-test', index++, 'fallback');
        sizeMessageFrames(root);
        const frame = root.querySelector('iframe');
        await until(() => frame.contentDocument?.URL === 'about:srcdoc' && frame.contentDocument?.readyState === 'complete');
        return frame;
      };
      const loadedLogo = async frame => {
        await until(() => frame.contentDocument.images[0]?.src.startsWith('data:image/png') && frame.contentDocument.images[0]?.naturalWidth > 0);
        check(!frame.sandbox.contains('allow-scripts'), 'Sandbox allows scripts');
        check(!frame.contentDocument.querySelector('meta[http-equiv]').content.includes(origin), 'CSP trusts logo host');
      };
      setEmailLogo(logo);
      let frame = await render(`<img alt="Space Casino" src="${logo}">`);
      await loadedLogo(frame);
      check(frame.contentDocument.images[0].naturalWidth === 88, 'Logo intrinsic size changed');
      check(!root.querySelector('.msg-remote-note'), 'Logo-only message still warns');
      // A translated/rerendered body uses the same renderer and cached logo.
      frame = await render(`<p>Translated body</p><img src="${logo}">`);
      await loadedLogo(frame);
      frame = await render(`<img src="${logo}"><img src="${origin}/tracker.png"><img src="${logo}?recipient=1"><div style="background-image:url('${logo}?css=1')">Background</div>`);
      await loadedLogo(frame);
      check([...frame.contentDocument.images].slice(1).every(i => i.naturalWidth === 0), 'Other remote image loaded');
      check(!!root.querySelector('.msg-remote-note'), 'Mixed message lost image control');
      setEmailLogo(`${origin}/other.svg`);
      frame = await render(`<img src="${logo}">`);
      check(frame.contentDocument.images[0].naturalWidth === 0, 'Old workspace logo remains trusted');
      setEmailLogo(`${origin}/slow.svg`);
      frame = await render(`<img src="${origin}/slow.svg">`);
      setEmailLogo(null);
      await new Promise(resolve => setTimeout(resolve, 500));
      check(frame.contentDocument.images[0].naturalWidth === 0, 'In-flight old workspace logo was installed');
      frame = await render(`<img src="${logo}">`);
      check(!!root.querySelector('.msg-remote-note'), 'Logout removed fallback control');
      setEmailLogo(`${origin}/unavailable.svg`);
      frame = await render(`<img src="${origin}/unavailable.svg">`);
      await new Promise(resolve => setTimeout(resolve, 200));
      check(frame.contentDocument.images[0].naturalWidth === 0 && !!root.querySelector('.msg-remote-note'), 'Image failure did not preserve fallback');
      const toDataURL = HTMLCanvasElement.prototype.toDataURL;
      let canvasDenied = false;
      try {
        HTMLCanvasElement.prototype.toDataURL = () => { canvasDenied = true; throw new DOMException('Tainted canvas', 'SecurityError'); };
        setEmailLogo(`${origin}/tainted.svg`);
        frame = await render(`<img src="${origin}/tainted.svg">`);
        await until(() => canvasDenied);
        check(frame.contentDocument.images[0].naturalWidth === 0 && !!root.querySelector('.msg-remote-note'), 'Canvas failure did not preserve fallback');
      } finally { HTMLCanvasElement.prototype.toDataURL = toDataURL; }
      enableRemoteImages('logo-test', index);
      frame = await render(`<img src="${origin}/manual.svg">`);
      await until(() => frame.contentDocument.images[0].naturalWidth > 0);
      setEmailLogo(null);
      frame = await render(`<img src="${origin}/attachment.svg">`, [{ url: `${origin}/attachment.svg` }]);
      await until(() => frame.contentDocument.images[0].naturalWidth > 0);
      root.remove();
    }, { logo, origin });
    if (requests.some(url => /tracker|recipient=|css=/.test(url))) throw Error('A tracking image reached the network');
    if (requests.filter(url => url === logo).length !== 1) throw Error('Logo was not cached across renders');
    return { passed: 'Logo loading/cache, original/translated bodies, exact URL isolation, CSS tracking protection, workspace switch/logout/race, image/canvas failure fallback, manual images, attachments, unchanged sandbox and CSP' };
  } finally {
    await page.unroute(`${origin}/**`);
    await page.unroute('http://localhost:5173/');
  }
}
