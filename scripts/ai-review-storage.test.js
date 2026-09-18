import { test, expect, mock } from 'bun:test';
let workspace = 'one';
const session = { userId: 'agent-one' };
const storage = new Map();
globalThis.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k), key: i => [...storage.keys()][i], get length() { return storage.size; } };
globalThis.window = { escHtml: s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'), escAttr: String };
mock.module('../web/js/core/state.js', () => ({ COMPOSE_TAB: 'reply', SESSION: session }));
mock.module('../web/js/core/api-client.js', () => ({ getWorkspaceId: () => workspace, getJwt: () => 'test', apiPost() {}, apiPatch() {} }));
mock.module('../web/js/core/event-delegation.js', () => ({ registerActions() {}, registerChangeActions() {}, registerInputActions() {} }));
const { loadDraft, saveDraft, loadDraftReview, saveDraftReview, clearDraft, loadMessageReview, confirmedReplySuggestion, hydrateSharedAiDraft, activateSharedAiDraft, textHtml } = await import('../web/js/tickets/drafts.js');
const { renderReplyReview } = await import('../web/js/ai/reply-review.js');

test('evidence stays visible with dates, markets, safe navigation and escaped warnings',()=>{
  workspace='a0000000-0000-4000-8000-000000000001';
  const output=renderReplyReview('T1',{references:[
    {id:'KB-1',title:'Policy',kind:'article',datedAt:'2026-09-01T12:00:00Z',market:'es-mx',warnings:['<unsafe>']},
    {id:'TK-1',title:'Previous reply',kind:'ticket',entityId:'a0000000-0000-4000-8000-000000000002',datedAt:'2026-08-01T12:00:00Z',market:'Mexico'},
  ],notes:[]},true);
  expect(output).toContain('data-action="td.openKB"');expect(output).toContain('Updated: 2026-09-01');
  expect(output).toContain('Market: es-mx');expect(output).toContain('Sent: 2026-08-01');
  expect(output).toContain('/tickets/a0000000-0000-4000-8000-000000000002');
  expect(output).toContain('&lt;unsafe&gt;');expect(output).not.toContain(' open>');
  expect(renderReplyReview('T1',{references:[],notes:[]},true)).toContain('Verify policy claims before sending');
  workspace='one';
});

test('internal metadata is separate, scoped, escaped and cleared after sending', () => {
  const review = { references: [{ id: 'KB-1', title: '<script>bad</script>', url: 'javascript:alert(1)' }], notes: ['Internal only'], suggestionId: 'a0000000-0000-4000-8000-000000000001', feedback: {helpful:false,reason:'wrong_match'} };
  saveDraft('T1', '<p>Customer reply</p>');
  saveDraftReview('T1', review);
  expect(loadDraft('T1')).toBe('<p>Customer reply</p>');
  expect(loadDraftReview('T1')).toEqual(review);
  expect(loadMessageReview('T1')).toEqual({ references: review.references, notes: review.notes });
  expect(confirmedReplySuggestion('T1')).toBeUndefined();
  saveDraftReview('T1',{...review,confirmedUse:true});
  expect(confirmedReplySuggestion('T1')).toBe(review.suggestionId);
  expect(confirmedReplySuggestion('T1','note')).toBeUndefined();
  expect(loadDraftReview('T1', 'note')).toBeNull();
  const output = renderReplyReview('T1');
  expect(output).toContain('References (1)');
  expect(output).not.toContain('<script>');
  expect(output).not.toContain('javascript:');
  const saved = renderReplyReview('T1', review, true);
  expect(saved).toContain('Saved with this reply for agents only.');
  expect(saved).not.toContain(' open>');
  workspace = 'two'; expect(loadDraftReview('T1')).toBeNull();
  workspace = 'one'; session.userId = 'agent-two'; expect(loadDraftReview('T1')).toBeNull();
  session.userId = 'agent-one'; clearDraft('T1');
  expect(loadDraftReview('T1')).toBeNull();
  expect(loadDraft('T1')).toBe('');
});

test('shared AI drafts restore safely and never overwrite a newer local edit',()=>{
  expect(textHtml('a < b & c')).toBe('<p>a &lt; b &amp; c</p>');
  const suggestionId='a0000000-0000-4000-8000-000000000009';
  clearDraft('T2','reply');
  hydrateSharedAiDraft('T2',{suggestionId,body:'Shared reply',isHtml:false,review:{references:[],notes:['Check']},version:2,updatedBy:'Alex'});
  expect(loadDraft('T2','reply')).toContain('Shared reply');
  expect(confirmedReplySuggestion('T2','reply')).toBe(suggestionId);
  saveDraft('T2','<p>My local edit</p>','reply');
  hydrateSharedAiDraft('T2',{suggestionId,body:'Changed elsewhere',isHtml:false,review:{references:[],notes:[]},version:3,updatedBy:'Sam'});
  expect(loadDraft('T2','reply')).toBe('<p>My local edit</p>');
  expect(loadDraftReview('T2','reply').sharedAvailable).toBe(true);
  activateSharedAiDraft('T2');
  expect(loadDraft('T2','reply')).toContain('Changed elsewhere');
  hydrateSharedAiDraft('T2',{suggestionId,body:'Changed elsewhere',isHtml:false,review:{references:[],notes:[]},version:3,rejected:true});
  expect(loadDraft('T2','reply')).toBe('');
  hydrateSharedAiDraft('T3',{suggestionId,body:'Same',isHtml:false,review:{references:[],notes:[]},version:2});
  hydrateSharedAiDraft('T3',{suggestionId,body:'Same',isHtml:false,review:{references:[],notes:[]},version:5});
  expect(loadDraftReview('T3','reply').sharedVersion).toBe(5);
});

test('loading shared HTML replaces existing rich composer content',async()=>{
  const host={dataset:{rich:'1'},appendChild(){},querySelector(){return null;}};
  globalThis.document={getElementById:id=>id==='compose-T4'?host:null,createElement(){return {};},head:{},querySelector(){return null;},dispatchEvent(){}};
  class FakeQuill {
    static last;
    constructor(container){this.container=container;this.clipboard={convert:value=>({ops:[{insert:value.html}]})};FakeQuill.last=this;}
    setContents(value,source){this.contents=value;this.source=source;}
    getLength(){return 1;}
    setSelection(){}
  }
  window.Quill=FakeQuill;
  const {mountComposer,setHtml}=await import('../web/js/tickets/composer.js');
  await mountComposer('T4');
  setHtml('T4','<p>Shared</p>');
  expect(FakeQuill.last.contents).toEqual({ops:[{insert:'<p>Shared</p>'}]});
  expect(FakeQuill.last.source).toBe('silent');
});
