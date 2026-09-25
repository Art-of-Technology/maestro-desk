import assert from 'node:assert/strict';
import './bridge-smoke-shim-prefix.js';
const create = document.createElement;
document.createElement = (...args) => ({ ...create(...args), remove() {} });
const listeners = [];
document.addEventListener = (type, fn) => { if (type === 'click') listeners.push(fn); };
await import('../web/js/app.js');
const { CUSTOMERS, TICKETS } = await import('../web/js/core/data.js');
const { setSession } = await import('../web/js/core/state.js');
const nodes = new Map(), make = document.getElementById;
document.getElementById = id => {
  if (!nodes.has(id)) nodes.set(id, { ...make(id), isConnected: true });
  return nodes.get(id);
};
const button = { disabled: false, isConnected: true };
document.querySelector = () => button;
const click = async (action, dataset = {}) => {
  const el = { dataset, getAttribute: () => action };
  for (const fn of listeners) fn({ target: { closest: () => el } });
  await new Promise(resolve => setTimeout(resolve, 0));
};
const ticket = TICKETS[0], customer = CUSTOMERS[0];
const note = { r: 'note', t: 'Original', from: 'Author', ts: '12:00', attachments: [{ id: 'file' }] };
ticket.msgs.push(note); const index = ticket.msgs.indexOf(note);
customer.notes = [{ text: 'Original', author: 'Author', ts: '12:00' }];
const main = document.getElementById('main-area'); main.innerHTML = 'Unsent reply and files';
for (const [action, ds, record, field, bodyId] of [
  ['td.editNote', { ticketId: ticket.id, msgIdx: String(index) }, note, 't', `ticket-note-${ticket.id}-${index}`],
  ['cust.editNote', { custId: customer.id, noteIdx: '0' }, customer.notes[0], 'text', `customer-note-${customer.id}-0`],
]) {
  setSession({ role: 'Agent' });
  document.getElementById('modal-container').innerHTML = '';
  await click(action, ds); assert.equal(document.getElementById('modal-container').innerHTML, '');
  setSession({ role: 'Admin' }); await click(action, ds);
  assert.match(document.getElementById('modal-container').innerHTML, /Edit note/);
  document.getElementById('edit-note-text').value = ' ';
  await click('modal.confirm'); assert.equal(record[field], 'Original');
  document.getElementById('edit-note-text').value = '<Edited>';
  await click('modal.confirm'); assert.equal(record[field], '<Edited>');
  const body = document.getElementById(bodyId);
  assert.ok((body.innerHTML || body.textContent).includes(action === 'td.editNote' ? '&lt;Edited&gt;' : '<Edited>'));
  assert.equal(record.ts, '12:00'); assert.equal(main.innerHTML, 'Unsent reply and files');
}
assert.deepEqual(note.attachments, [{ id: 'file' }]);
for (const [action, ds] of [
  ['td.noteHistory', { ticketId: ticket.id, msgIdx: String(index) }],
  ['cust.noteHistory', { custId: customer.id, noteIdx: '0' }],
]) {
  await click(action, ds);
  assert.match(document.getElementById('note-history').innerHTML, /Original/);
  assert.match(document.getElementById('note-history').innerHTML, /&lt;Edited&gt;/);
  assert.doesNotMatch(document.getElementById('note-history').innerHTML, /<Edited>/);
  setSession({ role: 'Agent' });
  document.getElementById('modal-container').innerHTML = '';
  await click(action, ds); assert.equal(document.getElementById('modal-container').innerHTML, '');
  setSession({ role: 'Admin' });
}

// A failed API save retains text, a double click sends once, and session drift cannot apply a late result.
ticket._uuid = 'ticket-fixture'; note._uuid = 'note-fixture';
let calls = 0, release, fail = true;
globalThis.fetch = async (_url, options) => {
  calls++; assert.equal(options.method, 'PATCH');
  assert.deepEqual(JSON.parse(options.body), { text: 'Saved', original_text: '<Edited>' });
  await new Promise(resolve => { release = resolve; });
  return new Response(JSON.stringify(fail ? { error: 'Try again' } : { note: { body: 'Saved' } }), { status: fail ? 500 : 200 });
};
await click('td.editNote', { ticketId: ticket.id, noteId: note._uuid, msgIdx: String(index) });
document.getElementById('edit-note-text').value = 'Saved';
await click('modal.confirm'); await click('modal.confirm'); assert.equal(calls, 1);
release(); await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(note.t, '<Edited>'); assert.equal(document.getElementById('edit-note-text').value, 'Saved');
assert.equal(document.getElementById('edit-note-error').textContent, 'Try again'); assert.equal(button.disabled, false);
fail = false; await click('modal.confirm'); release(); await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(note.t, 'Saved'); assert.equal(main.innerHTML, 'Unsent reply and files');
await click('td.editNote', { ticketId: ticket.id, noteId: note._uuid, msgIdx: String(index) });
document.getElementById('edit-note-text').value = 'Later';
globalThis.fetch = async () => { await new Promise(resolve => { release = resolve; }); return new Response(JSON.stringify({ note: { body: 'Later' } })); };
await click('modal.confirm'); sessionStorage.setItem('maestro_workspace_id', 'different'); release();
await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(note.t, 'Saved');
console.log('PASS: both note editors, admin gating, validation, author/time/files/draft preservation, escaping, API retry, duplicate clicks, session drift');

const { showNoteHistory } = await import('../web/js/core/note-editor.js');
globalThis.fetch = async () => { await new Promise(resolve => { release = resolve; }); return new Response(JSON.stringify({ revisions: [{ editor_label: '<Admin>', before_text: '<private>', after_text: 'edited', created_at: new Date().toISOString() }] })); };
const pendingHistory = showNoteHistory('/api/v1/history-fixture');
const historyHost = document.getElementById('note-history'); historyHost.innerHTML = '';
sessionStorage.setItem('maestro_workspace_id', 'another'); release(); await pendingHistory;
assert.equal(historyHost.innerHTML, '');
console.log('PASS: both revision viewers, escaped text, admin gating and late history response protection');
