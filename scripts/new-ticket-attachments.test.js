import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync('web/js/tickets/new-ticket.js', 'utf8');
const functions = source.slice(source.indexOf('async function createOnServer('), source.indexOf('// Demo persona'));
const actionsSource = source.slice(source.lastIndexOf('registerActions({'));
const cancelSource = source.slice(source.indexOf('function cancelWorkspace('), source.indexOf('function recipientPayload('));
function fixture() {
  let workspace = 'brand', failFile = '', failSync = false, failSend = false, failFinish = false, switchUpload = false, allowed = true;
  const posts = [], uploads = [], draft = { body: '', files: [], version: 0 }, notices = [], finished = [];
  const row = { id: 'ticket-uuid', display_id: 'TK-NEW', assigned_user_id: null };
  const context = { NT: { createdTicket: null }, TICKETS: [], FormData, SESSION: { name: 'Tester' },
    resolveTemplate: template => ({ text: template.text.replaceAll('{ticket}', 'TK-NEW'), html: template.html?.replaceAll('{ticket}', 'TK-NEW') || null }),
    unresolvedVariables: text => String(text).match(/\{[a-z_]+\}/gi) || [],
    saveDraftRecipients: (id, recipients) => { draft.recipients = recipients; },
    document: { getElementById: () => ({ isConnected: true }) },
    can: () => allowed, getWorkspaceId: () => workspace, getJwt: () => 'session',
    apiPost: async (path, body) => { posts.push({ path, body }); if (path === '/api/v1/tickets') return { ticket: row };
      if (failSend) throw Error('Synthetic send failure');
      return { delivery: { emailed: true }, draft_version: draft.version + 1 }; },
    apiPatch: async () => {}, updateOrInsertTicket: () => {}, setCustomerLanguage() {}, setBusy() {},
    apiUpload: async (path, form) => { const file = form.get('file'); uploads.push(file.name);
      if (switchUpload) workspace = 'other';
      if (file.name === failFile) throw Error('Synthetic upload failure');
      return { attachment: { id: file.name, filename: file.name, size_bytes: file.size } }; },
    saveDraft: (id, body) => { draft.body = body; }, saveDraftAttachments: (id, files) => { draft.files = files; },
    flushPersonalDraft: async () => { if (failSync && draft.files.length) throw Error('Synthetic sync failure'); return ++draft.version; },
    prepareDraftSend: async () => ({ version: ++draft.version, snapshot: { body: draft.body } }),
    finishDraftSend: (...args) => { finished.push(args); if (failFinish) throw Error('Synthetic cache failure'); }, notifyReplyDelivery() {}, showToast: text => notices.push(text),
  };
  runInNewContext(functions, context);
  const snap = { customerUuid: 'customer', recipients: { to: ['synthetic@example.test'], cc: ['copy@example.test'], mode: 'reply', sending_channel_id: null }, files: ['one.txt', 'two.txt'].map(name => ({ file: new File(['synthetic'], name), attachment: null })) };
  return { context, snap, draft, posts, uploads, notices, finished,
    run: (send = true) => context.createOnServer(snap, { message: 'Synthetic message', send }),
    set: options => { if ('failFile' in options) failFile = options.failFile; if ('failSync' in options) failSync = options.failSync;
      if ('failSend' in options) failSend = options.failSend; if ('failFinish' in options) failFinish = options.failFinish;
      if ('switchUpload' in options) switchUpload = options.switchUpload; if ('allowed' in options) allowed = options.allowed; },
  };
}
test('creates once, syncs private uploads and sends their IDs with the draft version', async () => {
  const f = fixture(), result = await f.run();
  expect(result.emailed).toBe(true);
  expect(f.posts).toHaveLength(2);
  expect(f.uploads).toEqual(['one.txt', 'two.txt']);
  expect(f.posts[1].body.attachment_ids).toEqual(['one.txt', 'two.txt']);
  expect(f.posts[1].body.draft_version).toBe(f.draft.version);
  expect(f.finished).toHaveLength(1);
});
test('save as draft keeps text and files without sending a customer message', async () => {
  const f = fixture(), result = await f.run(false);
  expect(result.keptDraft).toBe(true);
  expect(f.posts).toHaveLength(1);
  expect(f.draft.body).toBe('Synthetic message');
  expect(f.draft.files).toHaveLength(2);
});
test('partial upload failure retains selections and retries only the missing file on the same ticket', async () => {
  const f = fixture(); f.set({ failFile: 'two.txt' });
  expect((await f.run()).retry).toBe(true);
  expect(f.posts).toHaveLength(1);
  expect(f.draft.files.map(file => file.id)).toEqual(['one.txt']);
  expect(f.snap.files[1].file.name).toBe('two.txt');
  f.set({ failFile: '' });
  expect((await f.run()).emailed).toBe(true);
  expect(f.posts.filter(post => post.path === '/api/v1/tickets')).toHaveLength(1);
  expect(f.uploads).toEqual(['one.txt', 'two.txt', 'two.txt']);
});
test('a failed draft sync reuses the uploaded file, including retry after removing every selected file', async () => {
  const f = fixture(); f.set({ failSync: true });
  expect((await f.run()).retry).toBe(true);
  expect(f.snap.files[0].attachment.id).toBe('one.txt');
  f.set({ failSync: false }); f.snap.files = [];
  expect((await f.run()).emailed).toBe(true);
  expect(f.posts.filter(post => post.path === '/api/v1/tickets')).toHaveLength(1);
  expect(f.posts[1].body.attachment_ids).toEqual([]);
});
test('send failure opens the saved draft instead of offering a second ticket creation', async () => {
  const f = fixture(); f.set({ failSend: true });
  const result = await f.run();
  expect(result.keptDraft).toBe(true);
  expect(result.retry).toBeUndefined();
  expect(f.finished[0][3]).toBeUndefined();
  expect(f.draft.files).toHaveLength(2);
});
test('local draft cleanup failure cannot turn a completed send into a wizard retry', async () => {
  for (const failSend of [false, true]) {
    const f = fixture(); f.set({ failFinish: true, failSend });
    const result = await f.run();
    expect(result.retry).toBeUndefined();
    expect(result.displayId).toBe('TK-NEW');
    expect(f.posts).toHaveLength(2);
  }
});
test('permission denial and workspace changes prevent uploads or sending in another scope', async () => {
  const f = fixture(); f.set({ allowed: false });
  expect(await f.run()).toBeNull(); expect(f.posts).toHaveLength(0);
  f.set({ allowed: true, switchUpload: true });
  expect((await f.run()).aborted).toBe(true);
  expect(f.posts).toHaveLength(1);
  expect(f.snap.files[0].attachment).toBeNull();
  expect((await f.run()).aborted).toBe(true);
  expect(f.posts).toHaveLength(1);
});

test('selection, removal and cancellation stay local before ticket creation', () => {
  const actions = {}, changes = {}, toasts = [];
  const context = { NT: { busy: false, files: [], message: '', createdTicket: null },
    can: () => true, templateFilters: {},
    document: { getElementById: id => ({ value: id === 'nt2-msg' ? 'Keep this text' : '', focus() {} }) },
    registerActions: map => Object.assign(actions, map), registerChangeActions: map => Object.assign(changes, map), registerInputActions() {}, registerMousedownActions() {},
    currentWorkspace: () => true, harvestWorkspace: () => { context.NT.message = 'Keep this text'; }, renderWorkspace() {},
    hasUnfinishedTicket: () => true, window: { confirm: () => true }, closeWorkspace() {},
    showToast: text => toasts.push(text), closeModal() {}, resetNT: () => { context.NT.files = []; },
  };
  context.document.querySelector = () => null;
  runInNewContext(cancelSource + actionsSource, context);
  const file = new File(['synthetic'], 'receipt.txt');
  changes['nt.files']({}, { files: [file, new File([], 'empty.txt')] });
  expect(context.NT.files).toHaveLength(1); expect(context.NT.message).toBe('Keep this text');
  expect(toasts).toHaveLength(1);
  actions['nt.removeFile']({ index: '0' }); expect(context.NT.files).toHaveLength(0);
  changes['nt.files']({}, { files: [file] }); actions['nt.cancel']();
  expect(context.NT.files).toHaveLength(0);
  changes['nt.files']({}, { files: Array.from({ length: 21 }, () => file) });
  expect(context.NT.files).toHaveLength(20);
  context.NT.busy = true; actions['nt.removeFile']({ index: '0' }); expect(context.NT.files).toHaveLength(20);
  context.NT.busy = false; actions['nt.cancel']();
  changes['nt.files']({}, { files: [{ name: 'large.txt', size: 11 * 1024 * 1024 }] });
  expect(context.NT.files).toHaveLength(0);
});

test('sending rejects attachment-only messages and excessive combined size before creating a ticket', async () => {
  const alerts = [], context = { NT: { busy: false, files: [{ file: { size: 8 * 1024 * 1024 } }] },
    currentWorkspace: () => true, can: () => true, harvestWorkspace() {}, validateStep1: () => true, catOptions: () => [],
    recipientPayload: () => ({ to: ['synthetic@example.test'] }),
    document: { getElementById: () => ({ value: 'Synthetic', checkValidity: () => true }) }, alert: text => alerts.push(text), required: () => false,
  };
  runInNewContext(source.slice(source.indexOf('async function confirmSend('), source.indexOf('async function createOnServer(')), context);
  await context.confirmSend();
  expect(alerts[0]).toContain('max 7 MB');
  context.document.getElementById = () => ({ value: '', checkValidity: () => true });
  await context.confirmSend();
  expect(alerts[1]).toContain('Write a message');
});

test('leaving a partial upload requires confirmation and opens its existing draft', () => {
  const actions = {}, opened = [], saved = [];
  let leave = false;
  const context = { NT: { busy: false, files: [{ attachment: null }], createdTicket: { row: { display_id: 'TK-EXISTS' }, workspace: 'brand', jwt: 'session' } },
    window: { confirm: () => leave }, getWorkspaceId: () => 'brand', getJwt: () => 'session',
    document: { getElementById: () => ({ value: 'Preserved message' }) }, saveDraft: (...args) => saved.push(args),
    setComposeTabValue() {}, openTicket: id => opened.push(id), closeModal() {}, resetNT: () => { context.NT.files = []; },
    registerActions: map => Object.assign(actions, map), registerChangeActions() {}, registerInputActions() {}, registerMousedownActions() {},
    currentWorkspace: () => true, harvestWorkspace: () => { context.NT.message = 'Preserved message'; }, closeWorkspace() {},
    recipientPayload: () => ({}), saveDraftRecipients() {},
    resolveTemplate: template => template, SESSION: {},
  };
  runInNewContext(cancelSource + actionsSource, context);
  actions['nt.cancel'](); expect(context.NT.files).toHaveLength(1); expect(opened).toHaveLength(0);
  leave = true; actions['nt.cancel']();
  expect(opened).toEqual(['TK-EXISTS']); expect(saved[0]).toEqual(['TK-EXISTS', 'Preserved message', 'reply']);
  expect(context.NT.files).toHaveLength(0);
});

test('metadata-only drafts use the same versioned save without uploads or customer email', async () => {
  const f = fixture(); f.snap.files = [];
  const result = await f.context.createOnServer(f.snap, { message: '', send: false });
  expect(result.keptDraft).toBe(true);
  expect(f.posts).toHaveLength(1); expect(f.uploads).toHaveLength(0);
  expect(f.draft.body).toBe(''); expect(f.draft.recipients.cc).toBe('copy@example.test');
});

test('rich drafts retain HTML and resolve the minted ticket number before saving and sending', async () => {
  const f = fixture(); f.snap.files = []; f.snap.messageHtml = '<p>Reference <strong>{ticket}</strong></p>';
  await f.context.createOnServer(f.snap, { message: 'Reference {ticket}', send: true });
  expect(f.draft.body).toBe('<p>Reference <strong>TK-NEW</strong></p>');
  expect(f.posts[1].body.body_html).toBe(f.draft.body);
  expect(f.posts[1].body.body).toBe('Reference TK-NEW');
  expect(f.posts[1].body.email_recipients.cc).toEqual(['copy@example.test']);
});
