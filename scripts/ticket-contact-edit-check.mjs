import assert from 'node:assert/strict';
import './bridge-smoke-shim-prefix.js';
const createElement = document.createElement;
document.createElement = (...args) => ({ ...createElement(...args), remove() {} });

// Exercise real delegated actions and native modules with the existing DOM shim.
const listeners = [];
document.addEventListener = (type, fn) => { if (type === 'click') listeners.push(fn); };
await import('../web/js/app.js');
const { CUSTOMERS, TICKETS } = await import('../web/js/core/data.js');
const { setCurrentPage, setCurrentTicket } = await import('../web/js/core/state.js');
const { refreshTicketCustomer } = await import('../web/js/tickets/detail.js');
const { showContactDetailsModal } = await import('../web/js/customers/details-card.js');
const { getLayoutFields } = await import('../web/js/layouts/index.js');
const nodes = new Map();
const originalGet = document.getElementById;
document.getElementById = id => {
  if (!nodes.has(id)) nodes.set(id, originalGet(id));
  return nodes.get(id);
};
document.querySelector = selector => selector === '#modal-container #cust-pin'
  ? (document.getElementById('modal-container').innerHTML.includes('id="cust-pin"') ? {} : null)
  : originalGet();
const click = async (action, dataset = {}) => {
  const el = { dataset, getAttribute: () => action };
  for (const fn of listeners) fn({ target: { closest: () => el } });
  await new Promise(resolve => setTimeout(resolve, 0));
};
const c = CUSTOMERS.find(c => c.id === TICKETS[0].customerId);
setCurrentPage('tickets'); setCurrentTicket(TICKETS[0].id);
const panel = document.getElementById('ticket-customer'); panel.dataset.custId = c.id;
const main = document.getElementById('main-area'); main.innerHTML = 'ticket and unsent reply';
const composer = document.getElementById('composer'); composer.value = 'Keep my draft';
refreshTicketCustomer(c);
assert.match(panel.innerHTML, /Edit contact/);
await click('td.editContact', { custId: c.id });
assert.match(document.getElementById('modal-container').innerHTML, /cust.addContact/);
await click('cust.editDetails', { custId: c.id });
for (const f of getLayoutFields('customer')) {
  document.getElementById(`ed-${f.key}`).value = f.key === 'consent' ? (c.consent ? 'yes' : 'no') : String(c[f.key === 'backoffice_url' ? 'bo' : f.key] || '');
}
document.getElementById('ed-first').value = 'Updated';
await click('modal.confirm');
assert.match(document.getElementById('modal-container').innerHTML, /Save these changes/);
await click('modal.confirm');
assert.equal(c.first, 'Updated'); assert.match(panel.innerHTML, /Updated/);
assert.equal(main.innerHTML, 'ticket and unsent reply'); assert.equal(composer.value, 'Keep my draft');
assert.equal((await import('../web/js/core/state.js')).CURRENT_TICKET, TICKETS[0].id);

await click('td.editContact', { custId: c.id });
await click('cust.addContact', { custId: c.id, kind: 'email' });
document.getElementById('ac-value').value = 'updated@example.test';
document.getElementById('ac-primary').checked = true;
await click('modal.confirm');
assert.equal(c.email, 'updated@example.test'); assert.match(panel.innerHTML, /updated@example.test/);
await click('td.editContact', { custId: c.id });
const oldEmail = c.emails.find(x => !x.is_primary);
await click('cust.setPrimaryContact', { custId: c.id, kind: 'email', contactId: oldEmail.id, value: oldEmail.value });
assert.equal(c.email, oldEmail.value);
assert.match(document.getElementById('modal-container').innerHTML, new RegExp('cust.removeContact'));
const added = c.emails.find(x => x.value === 'updated@example.test');
await click('cust.removeContact', { custId: c.id, kind: 'email', contactId: added.id, value: added.value });
await click('modal.confirm');
assert.ok(!c.emails.includes(added));
assert.equal(main.innerHTML, 'ticket and unsent reply');

c._uuid = 'fixture-customer';
let fail = true, sent;
globalThis.fetch = async (url, options) => {
  assert.ok(url.endsWith('/api/v1/customers/fixture-customer'));
  assert.equal(options.method, 'PATCH');
  sent = JSON.parse(options.body);
  return new Response(JSON.stringify(fail ? { error: 'Save failed' } : {
    customer: { first_name: sent.first_name, last_name: c.last, email: c.email, emails: c.emails },
  }), { status: fail ? 500 : 200 });
};
await click('cust.editDetails', { custId: c.id });
for (const f of getLayoutFields('customer')) {
  document.getElementById(`ed-${f.key}`).value = f.key === 'consent' ? (c.consent ? 'yes' : 'no') : String(c[f.key === 'backoffice_url' ? 'bo' : f.key] || '');
}
document.getElementById('ed-first').value = 'Persisted';
await click('modal.confirm'); await click('modal.confirm');
assert.equal(c.first, 'Updated');
assert.match(document.getElementById('modal-container').innerHTML, /Save these changes/);
fail = false; await click('modal.confirm');
assert.deepEqual(sent, { first_name: 'Persisted' });
assert.equal(c.first, 'Persisted'); assert.match(panel.innerHTML, /Persisted/);
assert.equal(main.innerHTML, 'ticket and unsent reply'); assert.equal(composer.value, 'Keep my draft');

panel.dataset.custId = 'another-customer'; panel.innerHTML = 'Other contact';
refreshTicketCustomer(c); assert.equal(panel.innerHTML, 'Other contact');
for (const flag of ['erased', 'mergedInto']) {
  c[flag] = true; panel.dataset.custId = c.id; refreshTicketCustomer(c);
  assert.doesNotMatch(panel.innerHTML, /td.editContact/);
  document.getElementById('modal-container').innerHTML = '';
  showContactDetailsModal(c.id);
  assert.equal(document.getElementById('modal-container').innerHTML, '');
  delete c[flag];
}
console.log('PASS: ticket contact edit, confirmation, address controls, API failure/retry, draft preservation, different contact and locked profiles');
