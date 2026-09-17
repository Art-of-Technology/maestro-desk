import { test, expect, mock, beforeEach } from 'bun:test';

let scope = 'user:workspace', answer = 'Spanish', failure = false, release, calls = 0;
const cacheOptions = [];
const storage = new Map(), tickets = [];
globalThis.localStorage = { getItem: () => null };
globalThis.sessionStorage = { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v) };
const labels = new Map();
globalThis.document = { getElementById: id => labels.get(id) };
mock.module('../web/js/core/data.js', () => ({ TICKETS: tickets }));
mock.module('../web/js/core/state.js', () => ({ CURRENT_TICKET: null }));
mock.module('../web/js/tickets/detail.js', () => ({ openTicket() {} }));
mock.module('../web/js/core/modal.js', () => ({ showModal() {} }));
mock.module('../web/js/core/event-delegation.js', () => ({ registerActions() {} }));
const request = async body => {
  calls++;
  if (release) await new Promise(resolve => { release = resolve; });
  if (failure) throw new Error('Provider unavailable');
  return { text: body.action === 'detect_language' ? answer : 'Texto traducido' };
};
mock.module('../web/js/ai/client.js', () => ({ callClaude: request }));
mock.module('../web/js/ai/translation-cache.js', () => ({ translationScope: () => scope, messageTranslationRequest: (_key, _scope, _format, options) => { cacheOptions.push(options); return request; } }));
mock.module('../web/js/ai/formatted-translation.js', () => ({ translateFormatted: async (html, lang, req) => {
  await req({ action:'translate' });
  return { translation: 'Texto traducido', translationHtml: html.replace('Hello', 'Hola') };
} }));
const tx = await import('../web/js/ai/translate.js');
const fixture = () => ({ id:'T1', _uuid:'ticket-1', _detailLoaded:true, msgs:[{ _uuid:'m1',r:'customer',t:'Necesito ayuda con mi cuenta' }] });
beforeEach(() => { scope='user:workspace'; answer='Spanish'; failure=false; release=null; calls=0; cacheOptions.length=0; storage.clear(); tickets.length=0; labels.clear(); });

test('default is enabled and detection updates visible labels without opening controls', async () => {
  const t=fixture(); labels.set('customer-language-T1',{}); labels.set('reply-language-T1',{});
  const task=tx.ensureCustomerLanguage(t);
  expect(t.autoTranslateReplies).toBe(true);
  expect(labels.get('customer-language-T1').textContent).toContain('Detecting');
  await task;
  expect(labels.get('customer-language-T1').textContent).toBe('Customer language: Spanish · Detected automatically');
  expect(labels.get('reply-language-T1').textContent).toBe('Reply language: Spanish');
  await tx.ensureCustomerLanguage(t); expect(calls).toBe(1);
});
test('latest customer message is used and quoted email is excluded', async () => {
  const t=fixture(); t.msgs.push({r:'agent',t:'English'}, {r:'customer',t:'Bonjour à vous\nOn Tuesday someone wrote:\nHola'}, {r:'note',t:'German'});
  expect(tx.latestCustomerText(t).text).toBe('Bonjour à vous');
  answer='French'; await tx.ensureCustomerLanguage(t); expect(t.detectedCustomerLang).toBe('French');
  t.msgs.push({r:'customer',t:'Guten Morgen zusammen'}); answer='German';
  await tx.ensureCustomerLanguage(t); expect(t.detectedCustomerLang).toBe('German');
});
test('manual choice wins over delayed detection and survives a new ticket object', async () => {
  const t=fixture(); tickets.push(t); release=true;
  const task=tx.ensureCustomerLanguage(t); await Promise.resolve();
  tx.setCustomerLanguage('T1','French'); release(); await task; release=null;
  expect(t.detectedCustomerLang).toBe('French');
  expect(tx.customerLanguageStatus(t)).toContain('Selected manually');
  const refreshed=fixture(); tx.initialiseReplyLanguage(refreshed); expect(refreshed.detectedCustomerLang).toBe('French');
  scope='different:user'; const other=fixture(); tx.initialiseReplyLanguage(other); expect(other.detectedCustomerLang).toBeUndefined();
  tx.initialiseReplyLanguage(t); expect(t.detectedCustomerLang).toBeNull(); expect(t.customerLanguageManual).toBe(false);
});
test('unknown language and detection failure keep sending blocked without a retry loop', async () => {
  for(const unavailable of [false,true]) {
    const t=fixture(); answer='Unknown'; failure=unavailable;
    await tx.ensureCustomerLanguage(t);
    expect(tx.customerLanguageStatus(t)).toContain(unavailable ? 'Detection failed' : 'Unknown');
    const before=calls; await tx.ensureCustomerLanguage(t); expect(calls).toBe(before);
    await expect(tx.prepareCustomerReply(t,'Hello','<p>Hello</p>')).rejects.toThrow('Choose the customer language');
  }
});
test('Retry requests a fresh result and ordinary detection waits for it', async () => {
  const t=fixture(); tickets.push(t); answer='Unknown';
  await tx.ensureCustomerLanguage(t);
  release=true; answer='English';
  const retry=tx.retryCustomerLanguage(t.id); await Promise.resolve();
  const ordinary=tx.ensureCustomerLanguage(t);
  expect(tx.customerLanguageStatus(t)).toContain('Detecting');
  expect(cacheOptions.at(-1)).toEqual({refresh:true});
  release(); expect(await retry).toBe('English'); expect(await ordinary).toBe('English');
  expect(calls).toBe(2);
});
test('Retry recovers from failure and clears the visible error', async () => {
  const t=fixture(); tickets.push(t); failure=true;
  await tx.ensureCustomerLanguage(t); expect(t.customerLanguageError).toBe(true);
  failure=false; await tx.retryCustomerLanguage(t.id);
  expect(t.customerLanguageError).toBe(false); expect(tx.customerLanguageStatus(t)).toContain('Spanish');
});
test('a superseded detection cannot overwrite a newer retry', async () => {
  const t=fixture(); tickets.push(t); release=true;
  const old=tx.ensureCustomerLanguage(t); await Promise.resolve(); const finishOld=release;
  release=null; answer='English'; await tx.retryCustomerLanguage(t.id);
  answer='Spanish'; finishOld(); await old;
  expect(t.detectedCustomerLang).toBe('English');
});
test('manual selection stays in control during Retry', async () => {
  const t=fixture(); tickets.push(t); release=true;
  const retry=tx.retryCustomerLanguage(t.id); await Promise.resolve();
  tx.setCustomerLanguage(t.id,'French'); release(); await retry;
  expect(t.detectedCustomerLang).toBe('French'); expect(t.customerLanguageError).toBe(false);
});
test('translation errors stop sending, formatting is kept, and already-target text skips translation', async () => {
  const t=fixture(); tickets.push(t); tx.initialiseReplyLanguage(t); tx.setCustomerLanguage('T1','Spanish');
  answer='English';
  const result=await tx.prepareCustomerReply(t,'Hello','<p><strong>Hello</strong></p>');
  expect(result.translationHtml).toBe('<p><strong>Hola</strong></p>'); expect(result.translatedTo).toBe('Spanish');
  answer='Spanish'; calls=0;
  expect((await tx.prepareCustomerReply(t,'Hola','<p>Hola</p>')).translatedTo).toBeNull(); expect(calls).toBe(1);
  answer='English'; failure=true;
  await expect(tx.prepareCustomerReply(t,'Hello',null)).rejects.toThrow();
  tx.toggleAutoTranslateReplies('T1',false); calls=0;
  failure=false;
  const untranslated=await tx.prepareCustomerReply(t,'Hello','<p>Hello</p>');
  expect(untranslated.translation).toBe('Hello'); expect(untranslated.replyLanguage).toBe('English'); expect(calls).toBe(1);
});
test('late detection cannot cross workspaces', async () => {
  const t=fixture(); release=true;
  const task=tx.ensureCustomerLanguage(t); await Promise.resolve(); scope='other'; release(); await task;
  expect(t.detectedCustomerLang).toBeNull();
});
test('untranslated replies skip detection without a comparison language and tolerate provider failure', async () => {
  const t=fixture(); tickets.push(t); tx.initialiseReplyLanguage(t); tx.toggleAutoTranslateReplies('T1',false);
  let res=await tx.prepareCustomerReply(t,'Hello','<p>Hello</p>');
  expect(calls).toBe(0); expect(res.translation).toBe('Hello'); expect(res.replyLanguage).toBeNull();
  tx.setCustomerLanguage('T1','Spanish'); failure=true;
  res=await tx.prepareCustomerReply(t,'Hello','<p>Hello</p>');
  expect(calls).toBe(1); expect(res.translation).toBe('Hello'); expect(res.replyLanguage).toBeNull();
});
