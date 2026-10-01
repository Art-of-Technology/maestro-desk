import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../web/js/tickets/detail.js', import.meta.url), 'utf8');
const controls = source.slice(source.indexOf('function editTicketSubject('), source.indexOf('function editTicketNote('));

test('subject edits save server values without rebuilding the composer; errors and stale sessions keep local state', async () => {
  for (const scenario of ['saved', 'failed', 'switched', 'invalid']) {
    const ticket = { id: 'TK-116', _uuid: 'uuid', subject: 'Original' };
    const input = { value: '  New subject  ', reportValidity: () => scenario !== 'invalid', focus() {} };
    const heading = { textContent: 'Original' }, error = { textContent: '' };
    let confirm, closed = false, workspace = 'one', payload;
    const context = {
      TICKETS: [ticket], CURRENT_TICKET: ticket.id,
      window: { escAttr: s => s }, getWorkspaceId: () => workspace, getJwt: () => 'session',
      document: { getElementById: id => ({ 'edit-ticket-subject': input, 'edit-subject-error': error, 'ticket-subject-TK-116': heading })[id] },
      showModal: (_title, _body, callback) => { confirm = callback; }, closeModal: () => { closed = true; }, showToast() {},
      apiPatch: async (_url, body) => {
        payload = body;
        if (scenario === 'failed') throw Error('Offline');
        if (scenario === 'switched') workspace = 'two';
        return { ticket: { subject: body.subject } };
      },
    };
    runInNewContext(controls + "editTicketSubject('TK-116');", context);
    await confirm();
    expect(ticket.subject).toBe(scenario === 'saved' ? 'New subject' : 'Original');
    expect(heading.textContent).toBe(ticket.subject);
    expect(closed).toBe(scenario === 'saved');
    if (scenario === 'failed') expect(error.textContent).toBe('Offline');
    if (scenario === 'invalid') expect(payload).toBeUndefined();
    else expect(payload.subject).toBe('New subject');
  }
});

test('save and exit stores reply HTML and notes separately, restores both, and stays put on storage failure or loading', async () => {
  const storage = new Map();
  let failed = false;
  globalThis.localStorage = {
    getItem: k => storage.get(k) || null,
    setItem: (k, v) => { if (failed) throw Error('Full'); storage.set(k, v); },
    removeItem: k => storage.delete(k),
  };
  globalThis.window ||= {};
  globalThis.sessionStorage = { getItem: () => null };
  const { saveDraft, loadDraft } = await import('../web/js/tickets/drafts.js');
  let exits = 0, tab = 'reply';
  const editor = { dataset: {}, value: 'Private note' };
  const composeInput = source.slice(source.indexOf('export function onComposeInput('), source.indexOf('function insertVar(')).replace('export ', '');
  const context = {
    document: { getElementById: id => id === 'compose-TK-116' ? editor : null },
    TICKETS: [], COMPOSE_TAB: tab, getHtml: () => tab === 'reply' ? '<p>Unsent reply</p>' : null,
    getPlainText: () => tab === 'reply' ? 'Unsent reply' : editor.value,
    saveDraft: (id, text) => saveDraft(id, text, tab), queueSharedAiDraftSave() {},
    hideMentionDropdown() {}, updateMentionDropdown() {}, setComposing() {}, isComposerEmpty: () => false,
    renderPage: () => { exits++; }, showToast() {},
    getWorkspaceId: () => 'workspace', getJwt: () => 'session', CURRENT_TICKET: 'TK-116',
    flushPersonalDraft: async () => {}, draftSyncStatus: () => 'Synced',
  };
  await runInNewContext(controls + composeInput + "saveDraftAndExit('TK-116');", context);
  tab = 'note'; context.COMPOSE_TAB = tab;
  await runInNewContext(controls + composeInput + "saveDraftAndExit('TK-116');", context);
  expect(loadDraft('TK-116', 'reply')).toBe('<p>Unsent reply</p>');
  expect(loadDraft('TK-116', 'note')).toBe('Private note');
  expect(exits).toBe(2);
  failed = true;
  editor.value = 'Updated note';
  await runInNewContext(controls + composeInput + "saveDraftAndExit('TK-116');", context);
  expect(exits).toBe(2);
  failed = false; editor.dataset.rich = '1'; editor.querySelector = () => null;
  await runInNewContext(controls + composeInput + "saveDraftAndExit('TK-116');", context);
  expect(exits).toBe(2);
  expect(loadDraft('TK-116', 'note')).toBe('Private note');
});

test('a draft-only ticket is deletable, but unloaded or nonblank tickets need delete permission', () => {
  const blank = source.slice(source.indexOf('function isTicketBlank('), source.indexOf('function deleteTicketPrompt('));
  for (const [ticket, expected] of [
    [{ _uuid: 'uuid', _detailLoaded: true, msgs: [] }, true],
    [{ _uuid: 'uuid', msgs: [] }, false],
    [{ msgs: [{ r: 'note' }] }, false],
    [{ msgs: [{ r: 'customer' }] }, false],
  ]) expect(runInNewContext(blank + 'isTicketBlank(ticket)', { ticket })).toBe(expected);
  expect(source).toContain('${(window.canDeleteRecords() || isTicketBlank(t)) ? `<button class="btn btn-sm btn-danger" data-action="td.deleteTicket"');
});
