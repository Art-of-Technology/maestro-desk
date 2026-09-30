import { test, expect, mock, beforeEach } from 'bun:test';
import { CANNED_RESPONSES, MACROS, TAG_LIBRARY, TICKETS } from '../web/js/core/data.js';

const actions = {}, changes = {};
let confirm, workspace = 'a', fail = false, release, calls, inputs;
let mutationFail = false, steps = [];
globalThis.window = { isAdmin: () => true, escHtml: String, escAttr: String };
globalThis.alert = () => {};
globalThis.localStorage = { getItem: () => null };
globalThis.document = {
  getElementById: id => inputs[id],
  querySelector: () => inputs.button,
};
mock.module('../web/js/core/router.js', () => ({ renderPage() {} }));
mock.module('../web/js/core/keybindings.js', () => ({ navTo() {} }));
mock.module('../web/js/core/activity-log.js', () => ({ logTicketEvent() {} }));
mock.module('../web/js/core/modal.js', () => ({ showModal: (_title, _html, cb) => { confirm = cb; }, closeModal() {} }));
mock.module('../web/js/core/event-delegation.js', () => ({
  registerActions: a => Object.assign(actions, a), registerChangeActions: a => Object.assign(changes, a),
  registerInputActions() {}, registerMousedownActions: a => Object.assign(actions, a),
}));
mock.module('../web/js/tickets/detail.js', () => ({ insertMacro() {}, openTicket() {}, onComposeInput() {},
  async changeTicketStatus(id, value) { steps.push('status'); if (!mutationFail) TICKETS.find(t => t.id === id).status = value; },
  changeTicketPriority() {}, changeTicketAgent() {},
  async addTicketTag(id, value) { steps.push('tag'); TICKETS.find(t => t.id === id).tags.push(value); },
}));
mock.module('../web/js/tickets/template-content.js', () => ({ appendTemplate() {} }));
mock.module('../web/js/core/api-client.js', () => ({
  getJwt: () => 'session', getWorkspaceId: () => workspace,
  async apiPost(path, body) {
    calls.push({ path, body });
    if (fail) throw new Error('Offline');
    if (release) await new Promise(resolve => { release = resolve; });
    if (path.endsWith('/use')) return { macro: { usage_count: 1, last_used_at: '2026-09-30T12:00:00Z' } };
    return path.endsWith('tags') ? { tag: { ...body, count: 0 } }
      : { macro: { ...body, id: 'uuid', display_id: 'MAC-1', usage_count: 0, last_used_at: null } };
  },
  async apiPut(path, body) { calls.push({ path, body }); return { macro: { ...body, id: 'uuid', display_id: 'MAC-1' } }; },
  async apiPatch(path, body) { calls.push({ path, body }); return { tag: body }; },
  async apiDelete(path) { calls.push({ path }); },
}));
await import('../web/js/tickets/macros.js');
await import('../web/js/tags/index.js');

beforeEach(() => {
  MACROS.length = 0; TAG_LIBRARY.length = 0; TICKETS.length = 0;
  workspace = 'a'; fail = false; release = null; calls = [];
  mutationFail = false; steps = [];
  inputs = Object.fromEntries(Object.entries({ 'tag-name': 'Welcome Offer', 'tag-type': 'manual', 'tag-conf': '',
    'mac-name': 'Waiting', 'mac-icon': '⏸', 'mac-desc': 'Follow up', 'tag-error': '', 'mac-error': '', button: '',
  }).map(([key, value]) => [key, { value, isConnected: true, textContent: '', disabled: false }]));
  inputs['mac-steps'] = { querySelectorAll: () => [{ dataset: { macStep: '0' },
    querySelector: selector => selector.includes('kind') ? { value: 'status' } : selector.includes('val') ? { value: 'pending' } : null,
  }] };
});

test('tags save through the API even when a workspace has no tickets', async () => {
  actions['tags.new'](); await confirm();
  expect(calls[0]).toEqual({ path: '/api/v1/tags', body: { tag: 'welcome-offer', kind: 'manual', ai_confidence: null } });
  expect(TAG_LIBRARY[0].tag).toBe('welcome-offer');
  actions['tags.edit']({ tag: 'welcome-offer' }); inputs['tag-name'].value = 'Free Spins'; await confirm();
  expect(calls[1].path).toBe('/api/v1/tags/welcome-offer');
  expect(TAG_LIBRARY[0].tag).toBe('free-spins');
  actions['tags.delete']({ tag: 'free-spins' }); await confirm();
  expect(calls[2].path).toBe('/api/v1/tags/free-spins');
  expect(TAG_LIBRARY).toHaveLength(0);
});

test('macro creation, edits and deletion use persisted UUIDs', async () => {
  actions['macros.new'](); await confirm();
  expect(calls[0].path).toBe('/api/v1/macros');
  expect(MACROS[0]).toMatchObject({ _uuid: 'uuid', id: 'MAC-1', name: 'Waiting' });
  actions['macros.edit']({ id: 'MAC-1' }); await confirm();
  expect(calls[1].path).toBe('/api/v1/macros/uuid');
  actions['macros.delete']({ id: 'MAC-1' }); await confirm();
  expect(calls[2].path).toBe('/api/v1/macros/uuid');
  expect(MACROS).toHaveLength(0);
});

for (const feature of ['tags', 'macros']) {
  test(feature + ' keeps failed saves out of the library and shows the error', async () => {
    fail = true; actions[feature + '.new'](); await confirm();
    expect(feature === 'tags' ? TAG_LIBRARY : MACROS).toHaveLength(0);
    expect(inputs[feature === 'tags' ? 'tag-error' : 'mac-error'].textContent).toContain('Offline');
    expect(inputs.button.disabled).toBe(false);
  });
  test(feature + ' ignores a late save after switching workspaces and blocks double submission', async () => {
    release = true; actions[feature + '.new'](); const pending = confirm(); await confirm();
    expect(calls).toHaveLength(1);
    workspace = 'b'; release(); await pending;
    expect(feature === 'tags' ? TAG_LIBRARY : MACROS).toHaveLength(0);
  });
}

test('macro steps run in order and record persisted usage only after successful changes', async () => {
  MACROS.push({ id: 'MAC-1', _uuid: 'uuid', actions: [{ kind: 'status', value: 'pending' }, { kind: 'tag', value: 'waiting' }] });
  TICKETS.push({ id: 'T1', status: 'open', tags: [] });
  await actions['macros.runAndClose']({ macroId: 'MAC-1', ticketId: 'T1' });
  expect(steps).toEqual(['status', 'tag']);
  expect(calls[0].path).toBe('/api/v1/macros/uuid/use');
  expect(MACROS[0].usageCount).toBe(1);
});

test('a failed macro mutation stops later steps and usage accounting', async () => {
  mutationFail = true;
  MACROS.push({ id: 'MAC-1', _uuid: 'uuid', actions: [{ kind: 'status', value: 'pending' }, { kind: 'tag', value: 'waiting' }] });
  TICKETS.push({ id: 'T1', status: 'open', tags: [] });
  await actions['macros.runAndClose']({ macroId: 'MAC-1', ticketId: 'T1' });
  expect(steps).toEqual(['status']); expect(calls).toHaveLength(0);
});

test('a missing reply template stops the macro before any changes', async () => {
  CANNED_RESPONSES.length = 0;
  MACROS.push({ id: 'MAC-1', actions: [{ kind: 'status', value: 'pending' }, { kind: 'reply', templateId: 'deleted' }] });
  TICKETS.push({ id: 'T1', status: 'open', tags: [] });
  await actions['macros.runAndClose']({ macroId: 'MAC-1', ticketId: 'T1' });
  expect(steps).toHaveLength(0); expect(calls).toHaveLength(0);
});
