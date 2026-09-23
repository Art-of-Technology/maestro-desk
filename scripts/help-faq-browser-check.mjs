// Run against the local static server with Playwright; no live API is needed.
export default async function checkHelpFAQ(page) {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  await page.route('**/api/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.goto('http://127.0.0.1:5178');
  await page.evaluate(() => window.login('Agent', 'Help tester', 'HT'));
  for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 660 }]) {
    await page.setViewportSize(size);
    await page.evaluate(async () => {
      (await import('/js/guides/index.js')).closeGuides(false);
      (await import('/js/core/router.js')).nav('help');
    });
    await page.locator('#sup-msg').fill('Keep this draft while reading answers.');
    const questions = page.locator('.help-faq-q');
    assert(await questions.count() >= 10, 'Getting-started FAQs should be present');
    const question = questions.nth(7);
    if (await question.getAttribute('aria-expanded') === 'true') await question.click();
    await question.scrollIntoViewIfNeeded();
    await question.focus();
    const before = await page.locator('.page-scroll').evaluate(el => {
      el.dataset.faqCheck = 'same-element';
      return el.scrollTop;
    });
    assert(before > 0, 'Test must start with the Help page scrolled down');
    await question.click();
    const answerId = await question.getAttribute('aria-controls');
    assert(await page.locator(`#${answerId}`).isVisible(), 'Click should expand the answer');
    assert(await question.getAttribute('aria-expanded') === 'true', 'Expanded state must be announced');
    const after = await page.locator('.page-scroll').evaluate(el => ({ top: el.scrollTop, marker: el.dataset.faqCheck }));
    assert(after.marker === 'same-element', 'Expanding must not replace the Help page');
    assert(Math.abs(after.top - before) <= 1, 'Expanding must preserve the scroll position');
    assert(await question.evaluate(el => el === document.activeElement), 'Focus must stay on the question');
    assert(await page.locator('#sup-msg').inputValue() === 'Keep this draft while reading answers.', 'FAQ interaction must preserve form input');
    await question.press('Enter');
    assert(await page.locator(`#${answerId}`).isHidden(), 'Enter should collapse the answer');
    await question.press('Space');
    assert(await page.locator(`#${answerId}`).isVisible(), 'Space should expand the answer');
    const last = questions.last();
    await last.click();
    assert(await question.getAttribute('aria-expanded') === 'true', 'Opening another answer must leave this one open');
    assert(await last.evaluate(el => el.getBoundingClientRect().right <= innerWidth), 'FAQ controls must fit the viewport');
    assert(await page.locator('.page-scroll').evaluate(el => el.scrollWidth <= el.clientWidth), 'Help content must not overflow horizontally');
  }
  return 'FAQ scroll, focus, keyboard, multiple answers and draft preservation passed at desktop and mobile sizes.';
}
