import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../web/js/tickets/drafts.js', import.meta.url),'utf8')
  .replace(/^import .*;\r?\n/gm,'').replace(/\bexport /g,'');
const empty = () => ({ body:'',recipients:null,review:null,version:0 });
function device(server = new Map(), storage = new Map()) {
  const control = { workspace:'workspace',jwt:'session',offline:false,hold:null };
  const api = {
    getJwt: () => control.jwt,
    apiGet: async path => {
      if (control.offline) throw Error('Offline');
      const copy = structuredClone(server.get(path) || empty());
      if (control.hold) await control.hold;
      return { draft:copy };
    },
    apiPut: async (path, body) => {
      if (control.offline) throw Error('Offline');
      const existing = server.get(path) || empty();
      if (existing.version !== body.version) throw Object.assign(Error('Conflict'),{status:409});
      const saved = {...structuredClone(body),version:existing.version+1};
      server.set(path,saved);
      if (control.hold) await control.hold;
      return {draft:structuredClone(saved)};
    },
  };
  const context = {
    api, TICKETS:[{id:'TK-1',_uuid:'ticket'}],SESSION:{userId:'agent'},COMPOSE_TAB:'reply',
    getWorkspaceId:()=>control.workspace,document:{dispatchEvent(){},getElementById(){return null;}},
    CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail;}},
    setTimeout:()=>1,clearTimeout(){},window:{escHtml:v=>v},
    localStorage:{ getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k),
      get length(){return storage.size;},key:i=>[...storage.keys()][i] },
  };
  const draft = runInNewContext(source + '\n({saveDraft,loadDraft,saveDraftRecipients,loadDraftRecipients,saveDraftReview,loadDraftReview,clearDraft,flushPersonalDraft,refreshPersonalDraft,draftHasConflict,resolvePersonalDraft,prepareDraftSend,finishDraftSend,draftSyncStatus})',context);
  return {...draft,control,storage,server};
}
test('another device restores formatted reply, recipients and AI context; notes remain separate',async()=>{
  const a=device(),b=device(a.server);
  a.saveDraft('TK-1','<p><strong>Hello</strong></p>','reply');
  a.saveDraftRecipients('TK-1',{mode:'reply_all',to:['player@example.test'],cc:'copy@example.test'});
  a.saveDraftReview('TK-1',{references:[],notes:['Verify this'],suggestionId:'suggestion'},'reply');
  a.saveDraft('TK-1','Private note','note');
  await a.flushPersonalDraft('TK-1','reply'); await a.flushPersonalDraft('TK-1','note');
  await b.refreshPersonalDraft('TK-1','reply'); await b.refreshPersonalDraft('TK-1','note');
  expect(b.loadDraft('TK-1','reply')).toBe('<p><strong>Hello</strong></p>');
  expect(b.loadDraft('TK-1','note')).toBe('Private note');
  expect(b.loadDraftRecipients('TK-1').cc).toBe('copy@example.test');
  expect(b.loadDraftReview('TK-1','reply').notes).toEqual(['Verify this']);
});
test('offline edits survive and sync after reconnection; competing edits require an explicit choice',async()=>{
  const a=device(),b=device(a.server);
  a.control.offline=true;a.saveDraft('TK-1','Offline text','reply');
  await expect(a.flushPersonalDraft('TK-1','reply')).rejects.toThrow();
  expect(a.loadDraft('TK-1','reply')).toBe('Offline text');
  expect(a.draftSyncStatus('TK-1','reply')).toContain('locally');
  a.control.offline=false;await a.flushPersonalDraft('TK-1','reply');
  await b.refreshPersonalDraft('TK-1','reply');
  a.saveDraft('TK-1','Device A','reply');b.saveDraft('TK-1','Device B','reply');
  await a.flushPersonalDraft('TK-1','reply');
  await expect(b.flushPersonalDraft('TK-1','reply')).rejects.toThrow();
  expect(b.draftHasConflict('TK-1','reply')).toBe(true);
  expect(b.loadDraft('TK-1','reply')).toBe('Device B');
  await b.resolvePersonalDraft('TK-1','reply',false);
  expect(b.loadDraft('TK-1','reply')).toBe('Device A');
});
test('cleared and sent drafts cannot be resurrected by an old device',async()=>{
  const a=device(),b=device(a.server);
  a.saveDraft('TK-1','First draft','reply');await a.flushPersonalDraft('TK-1','reply');
  await b.refreshPersonalDraft('TK-1','reply');
  a.clearDraft('TK-1','reply');await a.flushPersonalDraft('TK-1','reply');
  b.saveDraft('TK-1','Old text edited offline','reply');
  await expect(b.flushPersonalDraft('TK-1','reply')).rejects.toThrow();
  expect(a.server.get('/api/v1/tickets/ticket/drafts/reply').body).toBe('');
  await b.resolvePersonalDraft('TK-1','reply',true);
  const sent = await b.prepareDraftSend('TK-1','reply');
  const version = sent.version+1;
  a.server.set('/api/v1/tickets/ticket/drafts/reply',{...empty(),version});
  expect(b.finishDraftSend('TK-1','reply',sent,version)).toBe(true);
  await a.refreshPersonalDraft('TK-1','reply');
  expect(a.loadDraft('TK-1','reply')).toBe('');expect(b.loadDraft('TK-1','reply')).toBe('');
});

test('browser tabs sharing a cache retain their own versions and cannot silently overwrite edits',async()=>{
  const a=device(),b=device(a.server,a.storage);
  await a.refreshPersonalDraft('TK-1','reply');await b.refreshPersonalDraft('TK-1','reply');
  a.saveDraft('TK-1','Tab A','reply');b.saveDraft('TK-1','Tab B','reply');
  await a.flushPersonalDraft('TK-1','reply');
  expect(b.loadDraft('TK-1','reply')).toBe('Tab B');
  await expect(b.flushPersonalDraft('TK-1','reply')).rejects.toThrow();
  expect(b.draftHasConflict('TK-1','reply')).toBe(true);
  expect(a.server.get('/api/v1/tickets/ticket/drafts/reply').body).toBe('Tab A');
});

test('a synced browser-only draft accepts later remote changes without a false conflict',async()=>{
  const a=device();a.storage.set('draft:v2:workspace:agent:TK-1:reply','Legacy text');
  await a.flushPersonalDraft('TK-1','reply');
  await a.flushPersonalDraft('TK-1','reply'); // A no-op flush must release its save lock too.
  const b=device(a.server);await b.refreshPersonalDraft('TK-1','reply');
  b.saveDraft('TK-1','New version','reply');await b.flushPersonalDraft('TK-1','reply');
  await a.refreshPersonalDraft('TK-1','reply');
  expect(a.loadDraft('TK-1','reply')).toBe('New version');
  expect(a.draftHasConflict('TK-1','reply')).toBe(false);
});
test('typing during a fetch or send stays local and is not erased by a late response',async()=>{
  const a=device();let release;
  a.control.hold=new Promise(resolve=>{release=resolve;});
  const loading=a.refreshPersonalDraft('TK-1','reply');
  a.saveDraft('TK-1','Typed during load','reply');
  a.control.hold=null;release();await loading;await a.flushPersonalDraft('TK-1','reply');
  expect(a.loadDraft('TK-1','reply')).toBe('Typed during load');
  const sent=await a.prepareDraftSend('TK-1','reply');
  a.saveDraft('TK-1','Next message','reply');
  a.server.set('/api/v1/tickets/ticket/drafts/reply',{...empty(),version:sent.version+1});
  expect(a.finishDraftSend('TK-1','reply',sent,sent.version+1)).toBe(false);
  await a.flushPersonalDraft('TK-1','reply');
  expect(a.server.get('/api/v1/tickets/ticket/drafts/reply').body).toBe('Next message');
});
test('a late save response after workspace switch cannot touch the new workspace',async()=>{
  const a=device();let release;
  await a.refreshPersonalDraft('TK-1','reply');
  a.saveDraft('TK-1','Private text','reply');
  a.control.hold=new Promise(resolve=>{release=resolve;});
  const saving=a.flushPersonalDraft('TK-1','reply');
  await Promise.resolve();a.control.workspace='other';a.control.hold=null;release();
  await expect(saving).rejects.toThrow();
  expect(a.loadDraft('TK-1','reply')).toBe('');
  expect([...a.storage.keys()].some(k=>k.includes(':other:'))).toBe(false);
});
