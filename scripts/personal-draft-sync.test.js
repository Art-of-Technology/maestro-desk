import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../web/js/tickets/drafts.js', import.meta.url),'utf8')
  .replace(/^import .*;\r?\n/gm,'').replace(/\bexport /g,'');
const empty = () => ({ body:'',recipients:null,review:null,attachments:[],version:0 });
function device(server = new Map(), storage = new Map()) {
  const control = { workspace:'workspace',jwt:'session',offline:false,hold:null,denied:0 };
  const api = {
    getJwt: () => control.jwt,
    apiGet: async path => {
      if (control.offline) throw Error('Offline');
      if (control.denied) throw Object.assign(Error('Unavailable'),{status:control.denied});
      const copy = structuredClone(server.get(path) || empty());
      if (control.hold) await control.hold;
      return { draft:copy };
    },
    apiPut: async (path, body) => {
      if (control.offline) throw Error('Offline');
      if (control.denied) throw Object.assign(Error('Unavailable'),{status:control.denied});
      const existing = server.get(path) || empty();
      if (existing.version !== body.version) throw Object.assign(Error('Conflict'),{status:409});
      const saved = {...structuredClone(body),attachments:(body.attachment_ids||[]).map(id=>server.files.get(id)),version:existing.version+1};
      server.set(path,saved);
      if (control.hold) await control.hold;
      return {draft:structuredClone(saved)};
    },
  };
  const listeners=new Map();
  const emit=(type,event={})=>{for(const fn of listeners.get(type)||[])fn(event);};
  const context = {
    api, TICKETS:[{id:'TK-1',_uuid:'ticket'}],SESSION:{userId:'agent'},COMPOSE_TAB:'reply',
    getWorkspaceId:()=>control.workspace,document:{dispatchEvent(){},getElementById(){return null;}},
    CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail;}},
    setTimeout:()=>1,clearTimeout(){},window:{escHtml:v=>v,addEventListener:(type,fn)=>listeners.set(type,[...(listeners.get(type)||[]),fn]),dispatchEvent:event=>emit(event.type,event)},
    localStorage:{ getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k),
      get length(){return storage.size;},key:i=>[...storage.keys()][i] },
  };
  server.files ||= new Map();
  const draft = runInNewContext(source + '\n({saveDraft,loadDraft,saveDraftRecipients,loadDraftRecipients,saveDraftReview,loadDraftReview,saveDraftAttachments,loadDraftAttachments,clearDraft,flushPersonalDraft,refreshPersonalDraft,draftHasConflict,resolvePersonalDraft,prepareDraftSend,finishDraftSend,draftSyncStatus,clearBrowserDrafts,flushBrowserDrafts,invalidateDraftTicket,personalDraftReady,personalDraftEditable})',context);
  return {...draft,control,storage,server,tickets:context.TICKETS,session:context.SESSION,emit};
}
test('draft files restore, conflict on removal, and clear after send even when new text is typed',async()=>{
  const a=device(),b=device(a.server),file={id:'file',filename:'receipt.pdf',size_bytes:123,mime_type:'application/pdf',is_inline:false,disposition:'attachment'};
  a.server.files.set(file.id,file);
  a.saveDraftAttachments('TK-1',[file]);await a.flushPersonalDraft('TK-1','reply');
  await b.refreshPersonalDraft('TK-1','reply');expect(b.loadDraftAttachments('TK-1')).toEqual([file]);
  const reload=device(a.server,b.storage);expect(reload.loadDraftAttachments('TK-1')).toEqual([]);
  await reload.refreshPersonalDraft('TK-1','reply');expect(reload.loadDraftAttachments('TK-1')).toEqual([file]);
  b.saveDraftAttachments('TK-1',[]);a.saveDraft('TK-1','A new message','reply');await a.flushPersonalDraft('TK-1','reply');
  await expect(b.flushPersonalDraft('TK-1','reply')).rejects.toThrow();
  await b.resolvePersonalDraft('TK-1','reply',false);expect(b.loadDraftAttachments('TK-1')).toEqual([file]);
  const sent=await b.prepareDraftSend('TK-1','reply');
  expect(()=>b.saveDraftAttachments('TK-1',[])).toThrow('sending');
  b.saveDraft('TK-1','Next message','reply');
  a.server.set('/api/v1/tickets/ticket/drafts/reply',{...empty(),version:sent.version+1});
  b.finishDraftSend('TK-1','reply',sent,sent.version+1);await b.flushPersonalDraft('TK-1','reply');
  expect(b.loadDraftAttachments('TK-1')).toEqual([]);expect(b.loadDraft('TK-1','reply')).toBe('Next message');
});
test('background refresh absorbs save failures and sending releases a removed ticket',async()=>{
  const a=device();a.control.offline=true;a.saveDraft('TK-1','Offline','reply');
  const failing=a.flushPersonalDraft('TK-1','reply').catch(()=>{});
  await expect(a.refreshPersonalDraft('TK-1','reply')).resolves.toBeUndefined();await failing;
  a.control.offline=false;const sent=await a.prepareDraftSend('TK-1','reply');
  const ticket=a.tickets.pop();a.finishDraftSend('TK-1','reply',sent);a.tickets.push(ticket);
  await expect(a.flushPersonalDraft('TK-1','reply')).resolves.toBeNumber();
});
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

test('logout flushes cached drafts and reload can finish the same pending revision',async()=>{
  const a=device();a.saveDraft('TK-1','Unsent reply','reply');a.saveDraft('TK-1','Unsent note','note');
  const reload=device(a.server,a.storage);await reload.flushBrowserDrafts();
  expect(a.server.get('/api/v1/tickets/ticket/drafts/reply').body).toBe('Unsent reply');
  expect(a.server.get('/api/v1/tickets/ticket/drafts/note').body).toBe('Unsent note');
  expect([...a.storage.keys()].some(k=>k.includes(':dirty:'))).toBe(false);
});

test('logout refuses offline, other-tab and other-workspace unsaved drafts',async()=>{
  const a=device(),b=device(a.server,a.storage);
  await a.refreshPersonalDraft('TK-1','reply');await b.refreshPersonalDraft('TK-1','reply');
  a.saveDraft('TK-1','A','reply');b.saveDraft('TK-1','B','reply');
  await expect(a.flushBrowserDrafts()).rejects.toThrow('Another tab');
  a.control.offline=true;a.saveDraft('TK-1','Offline','reply');
  await expect(a.flushBrowserDrafts()).rejects.toThrow('Offline');
  expect(a.loadDraft('TK-1','reply')).toBe('Offline');
  const c=device();c.storage.set('draft:v2:other:agent:TK-9:reply:sync',JSON.stringify({dirty:true}));
  await expect(c.flushBrowserDrafts()).rejects.toThrow('Another tab or workspace');
});

test('logout clears only this agent across workspaces, blocks late saves, and reaches other tabs',async()=>{
  const a=device(),b=device(a.server,a.storage);await a.refreshPersonalDraft('TK-1','reply');
  a.saveDraft('TK-1','Private text','reply');b.saveDraft('TK-1','Other tab text','reply');
  a.storage.set('draft:v2:other:agent:TK-2:reply','Other workspace');
  a.storage.set('draft:v2:workspace:another-agent:TK-1:reply','Keep');a.storage.set('draft:TK-99:reply','Legacy');
  let release;a.control.hold=new Promise(resolve=>{release=resolve;});
  const saving=a.flushPersonalDraft('TK-1','reply');await Promise.resolve();
  a.clearBrowserDrafts('agent');
  b.emit('storage',{key:'respovia:draft-signout:agent'});
  expect(b.loadDraft('TK-1','reply')).toBe('');
  a.control.hold=null;release();await expect(saving).rejects.toThrow();
  a.saveDraft('TK-1','Late edit','reply');b.saveDraft('TK-1','Late second tab','reply');
  expect([...a.storage.entries()].filter(([k])=>k.startsWith('draft:'))).toEqual([['draft:v2:workspace:another-agent:TK-1:reply','Keep']]);
  a.session.userId='another-agent';a.control.jwt='new-session';await a.refreshPersonalDraft('TK-1','reply');
  expect(a.loadDraft('TK-1','reply')).toBe('Keep');
});

test('access denial hides then clears cached contents without clearing another agent',async()=>{
  const a=device();a.storage.set('draft:v2:workspace:agent:TK-1:reply','Sensitive');
  a.storage.set('draft:v2:workspace:another-agent:TK-1:reply','Keep');
  expect(a.loadDraft('TK-1','reply')).toBe('');expect(a.personalDraftReady('TK-1')).toBe(false);
  a.control.denied=404;await a.refreshPersonalDraft('TK-1','reply');
  expect(a.loadDraft('TK-1','reply')).toBe('');expect(a.storage.has('draft:v2:workspace:agent:TK-1:reply')).toBe(false);
  expect(a.storage.get('draft:v2:workspace:another-agent:TK-1:reply')).toBe('Keep');
});

test('confirmed erasure clears every cached agent copy of the ticket and rejects late fetches',async()=>{
  const a=device(),b=device(a.server,a.storage);a.tickets[0].customerId='customer';
  a.storage.set('draft:v2:workspace:agent:TK-1:reply','Private');
  a.storage.set('draft:v2:workspace:another-agent:TK-1:reply','Private too');
  a.storage.set('draft:v2:elsewhere:agent:TK-1:reply','Keep');
  a.storage.set('draft:v2:workspace:agent:TK-2:reply','Keep too');
  let release;a.control.hold=new Promise(resolve=>{release=resolve;});const loading=a.refreshPersonalDraft('TK-1');
  a.emit('respovia:customer-erased',{detail:{id:'customer'}});
  b.emit('storage',{key:'respovia:draft-erased',newValue:a.storage.get('respovia:draft-erased')});
  a.control.hold=null;release();await loading;
  a.saveDraft('TK-1','Late text');b.saveDraft('TK-1','Late tab text');
  expect([...a.storage.entries()].filter(([k])=>k.startsWith('draft:'))).toEqual([
    ['draft:v2:elsewhere:agent:TK-1:reply','Keep'],['draft:v2:workspace:agent:TK-2:reply','Keep too']]);
});

const appSource=readFileSync(new URL('../web/js/app.js',import.meta.url),'utf8');
const logoutSource=appSource.slice(appSource.indexOf('let logoutPending='),appSource.indexOf("window.addEventListener('respovia:session-warning'"));
function logoutHarness(flush,confirm=true){
  const calls=[];const elements=new Map();
  const context={SESSION:{userId:'agent'},flushBrowserDrafts:flush,window:{confirm:()=>{calls.push('confirm');return confirm;}},setTimeout,clearTimeout,
    document:{getElementById:id=>{if(!elements.has(id))elements.set(id,{style:{}});return elements.get(id);}},
    authSignOut:()=>{calls.push('signout');},setSession:value=>{context.SESSION=value;}};
  for(const name of ['closeModal','closeGuides','suspendUrlRouting','discardRequestedRoute','stopPresence','stopListSync','stopRealtime','resetTaglineSdk','resetWorkspaceBrand','hydrateLayouts'])context[name]=()=>{};
  const logout=runInNewContext(logoutSource+'\nlogout',context);return {logout,calls,context};
}
test('manual logout waits for saving; failure allows staying signed in or discarding; expiry skips saving',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});const a=logoutHarness(()=>gate);
  const pending=a.logout();expect(a.calls).toEqual([]);release();await pending;expect(a.calls).toEqual(['signout']);
  const offline=async()=>{throw Error('Offline');};const b=logoutHarness(offline,false);await b.logout();
  expect(b.calls).toEqual(['confirm']);expect(b.context.SESSION.userId).toBe('agent');
  const c=logoutHarness(offline,true);await c.logout();expect(c.calls).toEqual(['confirm','signout']);
  const d=logoutHarness(()=>{throw Error('Must not flush');});await d.logout({force:true});expect(d.calls).toEqual(['signout']);
});
test('expiry during logout and account changes cannot sign out the next session',async()=>{
  let reject;const a=logoutHarness(()=>new Promise((_,r)=>{reject=r;}));const pending=a.logout();
  await a.logout({force:true});reject(Error('Expired'));await pending;expect(a.calls).toEqual(['signout']);
  let release;const b=logoutHarness(()=>new Promise(r=>{release=r;}));const switching=b.logout();
  b.context.SESSION={userId:'next-agent'};release();await switching;expect(b.calls).toEqual([]);
});

test('editing one field before verification cannot reveal other cached fields',async()=>{
  const a=device();a.storage.set('draft:v2:workspace:agent:TK-1:reply','Private cached body');
  a.storage.set('draft:v2:workspace:agent:TK-1:reply:ai-review',JSON.stringify({references:[],notes:['Private review']}));
  a.saveDraftRecipients('TK-1',{mode:'reply',to:['new@example.test'],cc:''});
  expect(a.loadDraft('TK-1')).toBe('');expect(a.loadDraftReview('TK-1')).toBeNull();
  expect(a.loadDraftRecipients('TK-1').to).toEqual(['new@example.test']);
  a.control.denied=403;await a.refreshPersonalDraft('TK-1');
  expect(a.loadDraftRecipients('TK-1')).toBeNull();
});


test('transient failures allow new offline drafts without exposing or replacing cached work',async()=>{
  const a=device();a.control.offline=true;
  expect(a.personalDraftEditable('TK-1')).toBeFalsy();
  await a.refreshPersonalDraft('TK-1');expect(a.personalDraftEditable('TK-1')).toBe(true);
  expect(a.personalDraftReady('TK-1')).toBe(false);
  a.saveDraft('TK-1','New offline text');await a.refreshPersonalDraft('TK-1');
  expect(a.personalDraftEditable('TK-1')).toBe(true);expect(a.loadDraft('TK-1')).toBe('New offline text');
  await a.flushPersonalDraft('TK-1').catch(()=>{});
  a.control.offline=false;await a.flushPersonalDraft('TK-1');expect(a.personalDraftReady('TK-1')).toBe(true);
  const cached=device();cached.storage.set('draft:v2:workspace:agent:TK-1:reply','Existing private draft');
  cached.control.offline=true;await cached.refreshPersonalDraft('TK-1');
  expect(cached.personalDraftEditable('TK-1')).toBeFalsy();expect(cached.loadDraft('TK-1')).toBe('');
  expect(cached.storage.get('draft:v2:workspace:agent:TK-1:reply')).toBe('Existing private draft');
  a.control.denied=403;await a.refreshPersonalDraft('TK-1');expect(a.personalDraftEditable('TK-1')).toBe(false);
});
