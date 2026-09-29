// Local fixtures only; run through the Playwright tool with scripts/serve-spa.js.
export default async function checkOwnerInvitation(page) {
  if (!page.url().startsWith('http://localhost:5173/')) throw Error('Local fixture only');
  await page.unroute('**/api/**');
  const id = '00000000-0000-4000-8000-000000000001';
  const inviteLink = `http://localhost:5173/?invitation=1#/w/${id}/dashboard`;
  const brand = { id, name: 'Invitation test', slug: 'invitation-test', plan: 'free', ai_credits_micro: 0 };
  let creates = 0, invites = 0;
  await page.route('**/api/**', route => {
    const path = route.request().url().split('?')[0];
    const post = route.request().method() === 'POST';
    let json = {};
    if (path.endsWith('/god/brands') && post) { creates++; json = { brand }; }
    else if (path.endsWith('/invite') && post) {
      invites++;
      json = { email: 'owner@example.test', invite_link: inviteLink, email_sent: invites > 1, invitation_type: 'sign_in' };
    } else if (path.endsWith(`/god/brands/${id}`)) json = { brand, domains: [], counts: {} };
    else if (path.endsWith('/god/brands')) json = { brands: [brand] };
    return route.fulfill({ json });
  });
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(inviteLink);
  await page.locator('#owner-invitation-hint').waitFor({ state: 'visible' });
  if (page.url().includes('?invitation=')) throw Error('Invitation flag must not force sign-in again on refresh');
  if (!page.url().includes(`/w/${id}/dashboard`)) throw Error('Workspace destination lost');
  await page.getByRole('button', { name: 'Request a setup link' }).click();
  await page.getByText('Set up or reset your password', { exact: true }).waitFor({ state: 'visible' });
  await page.evaluate(async () => {
    window.login('Admin', 'Invitation tester', 'IT');
    (await import('/js/guides/index.js')).closeGuides(false);
  });
  await page.waitForURL('**/#/dashboard');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(async () => {
    const form = await import('/js/god/new-brand.js');
    form.resetForm();
    document.body.dataset.currentPage = 'god';
    document.body.dataset.godView = 'new-brand';
    document.getElementById('main-area').innerHTML = form.renderNewBrand();
  });
  await page.locator('[data-input-action="god.nb.name"]').fill(brand.name);
  await page.locator('[data-input-action="god.nb.slug"]').fill(brand.slug);
  await page.locator('[data-input-action="god.nb.owner_email"]').fill('owner@example.test');
  await page.locator('[data-action="god.submitNewBrand"]').click();
  await page.locator('#invite-link-input').waitFor();
  if (await page.locator('#invite-link-input').inputValue() !== inviteLink) throw Error('Share link missing');
  await page.evaluate(() => { navigator.clipboard.writeText = async text => { window.copiedInvite = text; }; });
  await page.locator('[data-action="god.copyInviteLink"]').click();
  if (await page.evaluate(() => window.copiedInvite) !== inviteLink) throw Error('Copy did not receive the invitation link');
  await page.getByText('Email was not sent.', { exact: false }).waitFor();
  await page.locator('[data-action="god.retryOwnerInvite"]').click();
  await page.getByText('Invitation email sent to the owner.', { exact: true }).waitFor();
  if (creates !== 1 || invites !== 2) throw Error('Retry must only send an invitation');
  await page.locator('[data-action="god.openCreatedBrand"]').click();
  await page.locator('#brand-owner-email').fill('owner@example.test');
  await page.getByRole('button', { name: 'Send owner invitation', exact: true }).click();
  await page.locator('#invite-link-input').waitFor();
  if (await page.locator('#invite-link-input').inputValue() !== inviteLink || invites !== 3 || creates !== 1) throw Error('Existing brand invitation failed');
  return { landing: 'pass', setup: 'pass', shareLink: 'pass', retry: 'pass', existingBrand: 'pass', creates, invites };
}
