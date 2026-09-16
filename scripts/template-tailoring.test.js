import { beforeEach, expect, mock, test } from 'bun:test';

let workspace = 'one', confirm, inserted, status, fields, preview, modalBody;
const host = { dispatchEvent() {} };
mock.module('../web/js/core/data.js', () => ({ CUSTOMERS: [{ id: 'C1', first: 'Sam', brand: 'Example' }] }));
mock.module('../web/js/core/state.js', () => ({ SESSION: { name: 'Agent' }, COMPOSE_TAB: 'reply' }));
mock.module('../web/js/core/api-client.js', () => ({ getWorkspaceId: () => workspace, getJwt: () => 'test-session' }));
mock.module('../web/js/tickets/composer.js', () => ({ mountComposer: async () => {}, appendHtml: (id, html, text) => { inserted = { id, html, text }; } }));
mock.module('../web/js/core/modal.js', () => ({ showModal: (_title, body, callback) => { confirm = callback; modalBody = body; }, closeModal() {} }));
globalThis.window = { escHtml: String };
globalThis.document = { getElementById: id => id === 'compose-T1' ? host : id === 'tailor-status' ? status : id === 'tailor-preview' ? preview : fields[id] };
const { resolveTemplate, appendTemplate } = await import('../web/js/tickets/template-content.js');
const ticket = { id: 'T1', customerId: 'C1' };

beforeEach(() => {
  workspace = 'one'; confirm = null; inserted = null; status = { textContent: '' };
  preview = { textContent: '' };
  fields = { 'tailor-0': { value: '', focus() {}, addEventListener(type, callback) { this.onInput = callback; } } };
});
test('known variables fill automatically; unknown values remain explicit', () => {
  expect(resolveTemplate({ text: 'Hi {name}, {brand}: {ticket}, {agent}, {reference}' }, ticket).text)
    .toBe('Hi Sam, Example: T1, Agent, {reference}');
  expect(resolveTemplate({ text: '{name} {brand} {constructor}' }, { id: 'T2' }).text)
    .toBe('{name} {brand} {constructor}');
});
test('tailoring rejects empty fields and unresolved nested variables, then inserts the completed reply', async () => {
  expect(await appendTemplate(ticket, { text: 'Hi {name}, check {reference}.' })).toBe(false);
  expect(inserted).toBeNull();
  confirm(); expect(status.textContent).toContain('Fill in every field');
  fields['tailor-0'].value = '{another_value}'; confirm(); expect(inserted).toBeNull();
  fields['tailor-0'].value = 'REF-42'; confirm();
  expect(inserted.text).toBe('Hi Sam, check REF-42.');
});
test('an open tailoring form cannot insert into another workspace', async () => {
  await appendTemplate(ticket, { text: '{reference}' });
  fields['tailor-0'].value = 'REF-42'; workspace = 'two'; confirm();
  expect(inserted).toBeNull();
});
test('fully resolved templates show the customer details before insertion', async () => {
  expect(await appendTemplate(ticket, { text: 'Hi {name}' })).toBe(false);
  expect(inserted).toBeNull(); expect(modalBody).toContain('Hi Sam');
  confirm(); expect(inserted.text).toBe('Hi Sam');
});
test('preview updates as the agent tailors the response', async () => {
  await appendTemplate(ticket, { text: 'Hi {name}, {reference}' });
  fields['tailor-0'].value = '<REF-42>'; fields['tailor-0'].onInput();
  expect(preview.textContent).toBe('Hi Sam, <REF-42>');
});
